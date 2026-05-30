/**
 * realtime.js — Gemini Live Native Audio
 *
 * Modo Primário: Gemini 2.0 Flash Live (GEMINI_API_KEY)
 *   Modelo dedicado para conversas em tempo real (streaming bidirecional)
 *   VAD server-side configurável — end-of-speech HIGH (500ms silêncio)
 *   Echo suppression via _aiSpeaking flag
 *   Latência estimada: ~200–500ms first audio
 *   Pipeline: PCM16@16kHz → Gemini → PCM16@24kHz
 *
 * Modo Fallback (sem GEMINI_API_KEY ou erro na conexão):
 *   VAD client-side → Groq STT (~80ms) → GPT-4o-mini → OpenAI TTS
 *   Latência estimada: ~1.5s
 */

const WebSocket    = require('ws');
const https        = require('https');
const EventEmitter = require('events');

// ── Gemini Live ───────────────────────────────────────────────────────────────

// gemini-2.0-flash-live-001: modelo dedicado para streaming de voz em tempo real
// Não tem thinking mode, VAD agressivo, latência ~200-400ms first audio
const GEMINI_MODEL = 'models/gemini-2.0-flash-live-001';
const GEMINI_URL   = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const GEMINI_VOICE = 'Aoede'; // Aoede | Charon | Fenrir | Kore | Puck

// Taxa de amostragem do áudio
const INPUT_RATE  = 16000; // PCM@16kHz → Gemini (já upsampled em session.js)
const OUTPUT_RATE = 24000; // PCM@24kHz ← Gemini (downsampled em session.js)

// ── Pipeline fallback: VAD params ─────────────────────────────────────────────

const SILENCE_MS     = 250;   // ms de silêncio para cortar segmento
const SILENCE_THRESH = 300;   // RMS abaixo = silêncio
const MIN_AUDIO_MS   = 300;   // duração mínima para processar
const MIN_SPEECH_RMS = 400;   // pico mínimo de voz
const SAMPLE_RATE    = 16000; // taxa do buffer recebido em sendAudio()
const TTS_CHUNK      = 9600;  // ~200ms @ 24kHz PCM16 (2 bytes/sample)

// ─────────────────────────────────────────────────────────────────────────────

class RealtimeClient extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {string}   opts.apiKey      — OpenAI key (pipeline fallback)
   * @param {string}   [opts.groqKey]   — Groq key (STT rápido no fallback)
   * @param {string}   [opts.geminiKey] — Google Gemini API key (modo primário)
   * @param {string}   opts.instructions — system prompt
   */
  constructor({ apiKey, groqKey, geminiKey, instructions }) {
    super();
    this.apiKey       = apiKey;
    this.groqKey      = groqKey;
    this.geminiKey    = geminiKey;
    this.instructions = instructions;
    this.history      = [];
    this.connected    = false;
    this._mode        = 'unknown';

    // Gemini WebSocket
    this._ws        = null;
    this._wsReady   = false;

    // Echo suppression: true enquanto IA está gerando áudio (bloqueia realtimeInput)
    // Começa true — só libera após o primeiro turnComplete da saudação
    this._aiSpeaking = true;

    // Pipeline fallback: VAD state
    this._chunks       = [];
    this._totalSamples = 0;
    this._peakRms      = 0;
    this._silenceTimer = null;
    this._processing   = false;
  }

  // ── Conecta ──────────────────────────────────────────────────────────────

  async connect() {
    this.history = [{ role: 'system', content: this.instructions }];

    if (this.geminiKey) {
      try {
        await this._connectGemini();
        this._mode     = 'gemini';
        this.connected = true;
        console.log(`[Realtime] Modo: Gemini Live (${GEMINI_MODEL}) ✅`);
        return;
      } catch (err) {
        console.warn(`[Realtime] Gemini falhou (${err.message}) → fallback Pipeline`);
      }
    }

    this._mode     = 'pipeline';
    this.connected = true;
    console.log(`[Realtime] Modo: Pipeline (${this.groqKey ? 'Groq' : 'OpenAI'} STT + GPT-4o-mini + TTS)`);
  }

  // ── Gemini Live WebSocket ─────────────────────────────────────────────────

  _connectGemini() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${GEMINI_URL}?key=${this.geminiKey}`);
      this._ws = ws;

      let settled = false;
      const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const timer = setTimeout(() => settle(reject, new Error('timeout 10s')), 10000);

      ws.on('open', () => {
        console.log('[Gemini] WebSocket aberto — enviando setup...');
        ws.send(JSON.stringify({
          setup: {
            model: GEMINI_MODEL,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: GEMINI_VOICE },
                },
              },
              // Transcrição do que o usuário falou → aparece como [Cliente] no log
              // Permite auditar exatamente o que o Gemini "ouviu"
              inputAudioTranscription: {},
            },
            // VAD server-side: detecta início rápido, fim conservador (800ms)
            // silenceDurationMs alto evita cortar fala no meio (respiração, pausa)
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled:                 false,
                startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
                endOfSpeechSensitivity:   'END_SENSITIVITY_HIGH',
                silenceDurationMs:        800,
              },
              turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
            },
            systemInstruction: {
              parts: [{ text: this.instructions }],
            },
          },
        }));
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.setupComplete !== undefined) {
          console.log('[Gemini] Setup completo ✅');
          this._wsReady = true;
          settle(resolve);
          return;
        }

        // Log completo de todos os eventos (exceto dados de áudio)
        const dbg = JSON.parse(raw.toString());
        if (dbg.serverContent?.modelTurn?.parts) {
          dbg.serverContent.modelTurn.parts = dbg.serverContent.modelTurn.parts.map(p =>
            p.inlineData ? { inlineData: { mimeType: p.inlineData.mimeType, data: `<${p.inlineData.data?.length ?? 0} chars>` } } : p
          );
        }
        console.log('[Gemini ←]', JSON.stringify(dbg));

        this._handleGeminiMsg(msg);
      });

      ws.on('error', (e) => settle(reject, e));
      ws.on('close', (code, reason) => {
        const why = reason?.toString() || '';
        console.log(`[Gemini] Desconectado (${code}) ${why}`);
        if (!settled) {
          // Falhou durante setup — rejeita promise, NÃO emite 'close'
          // (a sessão vai continuar no fallback pipeline)
          settle(reject, new Error(`WS fechou (${code})`));
          return;
        }
        // Conexão ativa caiu — encerra sessão
        this.emit('close');
      });
    });
  }

  _handleGeminiMsg(msg) {
    const sc = msg.serverContent;
    if (!sc) return;

    // VAD server-side: cliente falou durante resposta da IA
    if (sc.interrupted) {
      console.log('[Gemini] VAD: interrupção detectada');
      this.emit('speech_start');
      return;
    }

    // Áudio gerado pela IA (PCM@24kHz em base64)
    const parts = sc.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.mimeType?.startsWith('audio/pcm') && part.inlineData.data) {
        const audioBuf = Buffer.from(part.inlineData.data, 'base64');
        this._aiSpeaking = true; // IA está falando → bloqueia eco
        this.emit('audio', audioBuf);
      }
      // Texto alternativo (raro no modo AUDIO, mas possível)
      if (part.text && !part.thought) {
        this.emit('transcript_ai', part.text);
      }
    }

    // Transcrição do áudio gerado pela IA
    const outTranscript = sc.outputTranscription?.text || sc.modelTurn?.outputTranscription?.text;
    if (outTranscript) {
      console.log('[IA]', outTranscript);
      this.emit('transcript_ai', outTranscript);
    }

    // Transcrição do áudio do cliente (inputAudioTranscription)
    const inTranscript = sc.inputTranscription?.text;
    if (inTranscript) {
      console.log('[Cliente]', inTranscript);
      this.emit('transcript_user', inTranscript);
    }

    // Turno concluído: IA parou de falar → guard de 200ms antes de abrir escuta
    // Evita que o eco dos últimos bytes de áudio da IA (ainda no speaker do telefone)
    // seja captado pelo microfone e enviado ao Gemini como "fala do usuário"
    if (sc.turnComplete) {
      setTimeout(() => {
        this._aiSpeaking = false;
        console.log('[Gemini] Turno completo — ouvindo usuário...');
      }, 200);
    }
  }

  _gSend(msg) {
    if (this._ws?.readyState !== WebSocket.OPEN) return;
    try { this._ws.send(JSON.stringify(msg)); } catch {}
  }

  // ── Áudio do usuário (chamado a cada pacote RTP) ──────────────────────────

  sendAudio(pcm16Buffer) {
    if (!this.connected) return;

    if (this._mode === 'gemini') {
      // Echo suppression: não envia ao Gemini enquanto IA está falando.
      // Evita que o eco acústico do speaker do telefone seja interpretado
      // como fala do usuário, gerando respostas duplicadas.
      if (this._aiSpeaking) return;

      this._audioSent = (this._audioSent || 0) + 1;
      if (this._audioSent === 1 || this._audioSent % 250 === 0) {
        console.log(`[Gemini →] audio chunk #${this._audioSent} (${pcm16Buffer.length} bytes)`);
      }
      // Streaming direto — Gemini faz VAD server-side
      this._gSend({
        realtimeInput: {
          mediaChunks: [{
            mimeType: `audio/pcm;rate=${INPUT_RATE}`,
            data:     pcm16Buffer.toString('base64'),
          }],
        },
      });
      return;
    }

    // Pipeline fallback: acumula e detecta silêncio (VAD client-side)
    const rms = this._rms(pcm16Buffer);
    this._chunks.push(pcm16Buffer);
    this._totalSamples += pcm16Buffer.length / 2;
    if (rms > this._peakRms) this._peakRms = rms;

    if (rms > SILENCE_THRESH) {
      if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
    } else if (!this._silenceTimer && this._totalSamples > 0) {
      this._silenceTimer = setTimeout(() => this._processSpeech(), SILENCE_MS);
    }
  }

  // ── Saudação inicial (500ms após chamada atendida) ────────────────────────

  greet() {
    const text = '(Chamada atendida. Cumprimente o cliente, diga seu nome e imobiliária, e faça a primeira pergunta de qualificação.)';

    if (this._mode === 'gemini') {
      console.log('[Gemini] Enviando saudação...');
      // _aiSpeaking permanece true até o primeiro turnComplete
      // Isso previne echo: usuário não pode "falar" enquanto IA gera saudação
      this._gSend({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      });
      return;
    }

    // Pipeline fallback
    setTimeout(async () => {
      try {
        const reply = await this._chat(text);
        if (!reply) return;
        console.log('[IA]', reply);
        this.emit('transcript_ai', reply);
        await this._ttsStream(reply);
      } catch (e) { console.error('[Realtime] Erro greet:', e.message); }
    }, 300);
  }

  // Gemini tem VAD server-side — interrupção é automática
  interrupt() {}

  // ── Pipeline fallback: VAD → STT → LLM → TTS ─────────────────────────────

  async _processSpeech() {
    this._silenceTimer = null;
    const durationMs = (this._totalSamples / SAMPLE_RATE) * 1000;
    const peakRms    = this._peakRms;

    if (durationMs < MIN_AUDIO_MS || peakRms < MIN_SPEECH_RMS || this._chunks.length === 0) {
      if (peakRms > 0 && peakRms < MIN_SPEECH_RMS) {
        console.log(`[VAD] Descartado (RMS ${Math.round(peakRms)} < ${MIN_SPEECH_RMS})`);
      }
      this._reset();
      return;
    }

    if (this._processing) { this._reset(); return; }
    this._processing = true;
    const buf = Buffer.concat(this._chunks);
    this._reset();

    const t0 = Date.now();
    try {
      const transcript = await this._stt(buf);
      if (!transcript || transcript.trim().length < 2) { this._processing = false; return; }
      console.log(`[Cliente] ${transcript}  (STT: ${Date.now() - t0}ms)`);
      this.emit('transcript_user', transcript);

      const reply = await this._chat(transcript);
      if (!reply) { this._processing = false; return; }
      console.log('[IA]', reply);
      this.emit('transcript_ai', reply);
      await this._ttsStream(reply);
    } catch (e) {
      console.error('[Realtime] Erro:', e.message);
    } finally {
      this._processing = false;
    }
  }

  // ── STT (Groq ou OpenAI Whisper) ─────────────────────────────────────────

  _stt(buf) { return this.groqKey ? this._groqSTT(buf) : this._openaiSTT(buf); }

  _groqSTT(buf) {
    return new Promise((resolve, reject) => {
      const wav = this._wav(buf, SAMPLE_RATE);
      const b   = '----GRQ' + Date.now();
      const body = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
        wav,
        Buffer.from(`\r\n--${b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`),
        Buffer.from(`--${b}--\r\n`),
      ]);
      const req = https.request({
        hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST',
        headers: {
          Authorization:    `Bearer ${this.groqKey}`,
          'Content-Type':   `multipart/form-data; boundary=${b}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d).text || ''); } catch { resolve(''); } });
      });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  _openaiSTT(buf) {
    return new Promise((resolve, reject) => {
      const wav = this._wav(buf, SAMPLE_RATE);
      const b   = '----VBB' + Date.now();
      const body = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
        wav,
        Buffer.from(`\r\n--${b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt\r\n`),
        Buffer.from(`--${b}--\r\n`),
      ]);
      const req = https.request({
        hostname: 'api.openai.com', path: '/v1/audio/transcriptions', method: 'POST',
        headers: {
          Authorization:    `Bearer ${this.apiKey}`,
          'Content-Type':   `multipart/form-data; boundary=${b}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d).text || ''); } catch { resolve(''); } });
      });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  // ── LLM: GPT-4o-mini (pipeline fallback) ─────────────────────────────────

  _chat(text) {
    this.history.push({ role: 'user', content: text });
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({
        model:       'gpt-4o-mini',
        messages:    this.history,
        max_tokens:  150,
        temperature: 0.7,
      }));
      const req = https.request({
        hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
        headers: {
          Authorization:    `Bearer ${this.apiKey}`,
          'Content-Type':   'application/json',
          'Content-Length': body.length,
        },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const reply = JSON.parse(d).choices?.[0]?.message?.content || '';
            this.history.push({ role: 'assistant', content: reply });
            if (this.history.length > 21) this.history = [this.history[0], ...this.history.slice(-20)];
            resolve(reply);
          } catch { resolve(''); }
        });
      });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  // ── TTS streaming: OpenAI (pipeline fallback) ────────────────────────────

  _ttsStream(text) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({
        model:           'tts-1',
        input:           text,
        voice:           'nova',
        response_format: 'pcm',
        speed:           1.0,
      }));
      const req = https.request({
        hostname: 'api.openai.com', path: '/v1/audio/speech', method: 'POST',
        headers: {
          Authorization:    `Bearer ${this.apiKey}`,
          'Content-Type':   'application/json',
          'Content-Length': body.length,
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let e = '';
          res.on('data', c => e += c);
          res.on('end', () => reject(new Error(`TTS ${res.statusCode}: ${e}`)));
          return;
        }
        let buf = Buffer.alloc(0); let first = true;
        res.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= TTS_CHUNK) {
            const piece = buf.slice(0, TTS_CHUNK);
            buf = buf.slice(TTS_CHUNK);
            if (first) { console.log('[TTS] Primeiro chunk ✅'); first = false; }
            this.emit('audio', piece);
          }
        });
        res.on('end',   () => { if (buf.length > 0) this.emit('audio', buf); resolve(); });
        res.on('error', reject);
      });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _reset() {
    this._chunks = []; this._totalSamples = 0; this._peakRms = 0;
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
  }

  _rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length - 1; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
    return Math.sqrt(sum / (buf.length / 2));
  }

  _wav(pcm16, sr) {
    const n = pcm16.length;
    const buf = Buffer.alloc(44 + n);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
    buf.writeUInt16LE(2, 32);  buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n, 40); pcm16.copy(buf, 44);
    return buf;
  }

  close() {
    this.connected   = false;
    this._aiSpeaking = true;
    this._reset();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this.emit('close');
  }
}

module.exports = RealtimeClient;
