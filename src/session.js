/**
 * session.js — Sessão de chamada ativa
 *
 * Orquestra: RTPHandler ↔ codec ↔ RealtimeClient (Realtime API)
 *
 * Pipeline de áudio:
 *   WaVoIP → RTP PCMU@8k → PCM16@8k → PCM16@16k → Gemini Live (ou pipeline fallback)
 *   Gemini Live → PCM16@24k → PCM16@8k → PCMU@8k → RTP → WaVoIP
 */

const RTPHandler     = require('./rtp');
const RealtimeClient = require('./realtime');
const { ulawToPcm16, pcm16ToUlaw, resample8to16, resample24to8, agcNormalize } = require('./codec');

class CallSession {
  /**
   * @param {object}   opts
   * @param {string}   opts.callId
   * @param {string}   opts.openaiKey   — OpenAI key (pipeline fallback)
   * @param {string}   [opts.groqKey]   — Groq key (STT rápido no fallback)
   * @param {string}   [opts.geminiKey] — Google Gemini key (modo primário)
   * @param {string}   opts.instructions — system prompt com contexto do lead
   * @param {Function} [opts.onEnd]     — callback quando a chamada termina
   */
  constructor({ callId, to, openaiKey, groqKey, geminiKey, instructions, onEnd }) {
    this.callId       = callId;
    this.to           = to;
    this.instructions = instructions;
    this.onEnd        = onEnd;
    this.startedAt    = new Date();
    this.transcript   = [];

    this.rtp      = new RTPHandler();
    this.realtime = new RealtimeClient({ apiKey: openaiKey, groqKey, geminiKey, instructions });

    this._setupPipeline();
  }

  _setupPipeline() {
    let rtpPackets   = 0;
    let aiChunks     = 0;

    // WaVoIP → Realtime: PCMU@8k → PCM16@8k → PCM16@16k
    this.rtp.on('pcmu', (pcmuBuf) => {
      rtpPackets++;
      if (rtpPackets === 1 || rtpPackets % 500 === 0) {
        console.log(`[Session ${this.callId}] RTP recebido: ${rtpPackets} pacotes`);
      }
      const pcm8k     = ulawToPcm16(pcmuBuf);
      const pcm8kAgc  = agcNormalize(pcm8k);   // normaliza nível (AGC)
      const pcm16k    = resample8to16(pcm8kAgc);
      this.realtime.sendAudio(pcm16k);
    });

    // Realtime → WaVoIP: PCM16@24k → PCM16@8k → PCMU@8k
    this.realtime.on('audio', (pcm24kBuf) => {
      aiChunks++;
      if (aiChunks === 1) {
        console.log(`[Session ${this.callId}] Primeiro áudio da IA recebido! ✅`);
      }
      const pcm8k  = resample24to8(pcm24kBuf);
      const pcmuBuf = pcm16ToUlaw(pcm8k);
      this.rtp.sendPCMU(pcmuBuf);
    });

    // Interrupção: cliente falou enquanto IA respondia (VAD server-side)
    this.realtime.on('speech_start', () => {
      this.realtime.interrupt();
    });

    // Log da transcrição
    this.realtime.on('transcript_ai',   (text) => {
      this.transcript.push({ role: 'ai',   text, ts: new Date().toISOString() });
    });
    this.realtime.on('transcript_user', (text) => {
      this.transcript.push({ role: 'user', text, ts: new Date().toISOString() });
    });

    this.realtime.on('close', () => this._handleEnd('realtime_closed'));
    this.realtime.on('error', (e) => console.error(`[Session ${this.callId}] Realtime error:`, e.message));
  }

  /**
   * Abre apenas o socket RTP.
   * A IA só conecta quando a chamada for atendida (setRemoteRTP).
   * @returns {Promise<number>} porta RTP local alocada
   */
  async start() {
    const rtpPort = await this.rtp.listen();
    console.log(`[Session ${this.callId}] RTP pronto — porta ${rtpPort}`);
    return rtpPort;
  }

  /**
   * Configura RTP remoto e conecta ao Realtime API — chamado após SIP 200 OK.
   */
  async setRemoteRTP(host, port) {
    this.rtp.setRemote(host, port);
    try {
      await this.realtime.connect();
      console.log(`[Session ${this.callId}] Pipeline Realtime pronto ✅`);
      setTimeout(() => this.realtime.greet(), 500);
    } catch (err) {
      console.error(`[Session ${this.callId}] Falha ao conectar Realtime:`, err.message);
      this._handleEnd('pipeline_failed');
    }
  }

  end(reason = 'manual') {
    this._handleEnd(reason);
  }

  _handleEnd(reason) {
    if (this._ended) return;
    this._ended = true;

    this.rtp.close();
    this.realtime.close();

    const duration = Math.round((Date.now() - this.startedAt) / 1000);
    console.log(`[Session ${this.callId}] Encerrada (${reason}) — ${duration}s`);

    if (this.onEnd) {
      this.onEnd({
        callId:     this.callId,
        reason,
        duration,
        transcript: this.transcript,
        startedAt:  this.startedAt.toISOString(),
      });
    }
  }
}

module.exports = CallSession;
