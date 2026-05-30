/**
 * rtp.js — Handler de pacotes RTP (áudio via UDP)
 *
 * Melhorias desta versão:
 *   - Fila contínua: múltiplas chamadas a sendPCMU() encadeiam os pacotes
 *     sem sobreposição — essencial para TTS streaming
 *   - resetAudio(): cancela áudio pendente (interrupção)
 *   - Timers rastreados — sem crash ERR_SOCKET_DGRAM_NOT_RUNNING
 */

const dgram = require('dgram');
const EventEmitter = require('events');

const RTP_HEADER_SIZE  = 12;
const PAYLOAD_PCMU     = 0;    // G.711 μ-law
const PACKET_DURATION  = 20;   // ms por pacote
const SAMPLE_RATE      = 8000;
const SAMPLES_PER_PKT  = (SAMPLE_RATE * PACKET_DURATION) / 1000; // 160

class RTPHandler extends EventEmitter {
  constructor() {
    super();
    this.socket = dgram.createSocket('udp4');
    this.remoteHost = null;
    this.remotePort = null;
    this.localPort  = null;

    this.seqNum    = Math.floor(Math.random() * 0xFFFF);
    this.timestamp = Math.floor(Math.random() * 0x3FFFFFFF); // max 1/4 do range — evita overflow
    this.ssrc      = Math.floor(Math.random() * 0xFFFFFFFF);

    this._timers      = [];   // timers pendentes
    this._nextSendAt  = 0;    // timestamp absoluto do próximo pacote
    this._closed      = false;
  }

  // ── Abre socket UDP ─────────────────────────────────────────────────────────

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this.socket.bind(port, '0.0.0.0', () => {
        this.localPort = this.socket.address().port;
        console.log(`[RTP] Escutando na porta UDP ${this.localPort}`);
        resolve(this.localPort);
      });

      this.socket.on('message', (msg, rinfo) => {
        if (!this.remoteHost) {
          this.remoteHost = rinfo.address;
          this.remotePort = rinfo.port;
          console.log(`[RTP] Remoto descoberto: ${rinfo.address}:${rinfo.port}`);
        }

        if (msg.length <= RTP_HEADER_SIZE) return;

        const payloadType = msg[1] & 0x7F;
        if (payloadType !== PAYLOAD_PCMU) return;

        this.emit('pcmu', msg.slice(RTP_HEADER_SIZE));
      });

      this.socket.on('error', reject);
    });
  }

  // ── Define destino remoto (do SDP) ──────────────────────────────────────────

  setRemote(host, port) {
    this.remoteHost  = host;
    this.remotePort  = parseInt(port);
    this._nextSendAt = 0; // reset da fila ao mudar destino
    console.log(`[RTP] Remoto configurado: ${host}:${port}`);
  }

  // ── Envia buffer PCMU — encadeia automaticamente na fila ───────────────────
  //
  // Múltiplas chamadas (ex: chunks TTS chegando em sequência) são agendadas
  // em sequência sem sobreposição, mantendo o fluxo de áudio contínuo.

  sendPCMU(pcmuData) {
    if (!this.remoteHost || !this.remotePort || this._closed) return;

    const CHUNK = SAMPLES_PER_PKT; // 160 bytes por pacote
    const total = Math.ceil(pcmuData.length / CHUNK);
    const now   = Date.now();

    // Se a fila está vazia ou no passado, começa agora
    if (this._nextSendAt < now) this._nextSendAt = now;

    for (let i = 0; i < total; i++) {
      const chunk = pcmuData.slice(i * CHUNK, (i + 1) * CHUNK);
      const seq   = this.seqNum++;
      const ts    = this.timestamp;
      this.timestamp  += SAMPLES_PER_PKT;

      const delay       = this._nextSendAt - now;
      this._nextSendAt += PACKET_DURATION; // avança o ponteiro 20ms

      const t = setTimeout(() => {
        if (this._closed || !this.remoteHost) return;

        const header = Buffer.alloc(RTP_HEADER_SIZE);
        header[0] = 0x80;
        header[1] = PAYLOAD_PCMU;
        header.writeUInt16BE(seq & 0xFFFF, 2);
        header.writeUInt32BE(ts >>> 0, 4);
        header.writeUInt32BE(this.ssrc, 8);

        const packet = Buffer.concat([header, chunk]);
        try {
          this.socket.send(packet, 0, packet.length, this.remotePort, this.remoteHost);
        } catch {}
      }, Math.max(0, delay));

      this._timers.push(t);
    }

    // Limpa referências de timers já disparados periodicamente
    if (this._timers.length > 500) {
      this._timers = this._timers.filter((t) => t._idleStart !== undefined);
    }
  }

  // ── Cancela áudio pendente (interrupção da IA) ──────────────────────────────

  resetAudio() {
    for (const t of this._timers) clearTimeout(t);
    this._timers     = [];
    this._nextSendAt = 0;
  }

  // ── Fecha socket ─────────────────────────────────────────────────────────────

  close() {
    this._closed = true;
    this.resetAudio();
    try { this.socket.close(); } catch {}
  }
}

module.exports = RTPHandler;
