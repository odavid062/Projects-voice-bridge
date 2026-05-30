/**
 * codec.js — Conversão de áudio G.711 μ-law ↔ PCM16 + resampling
 *
 * WaVoIP envia áudio G.711 (PCMU) a 8kHz.
 * Gemini Live espera PCM16 a 16kHz (input) e envia a 24kHz (output).
 */

// Tabela de decodificação μ-law → PCM16 (pré-calculada para performance)
const ULAW_TO_PCM = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let v = ~i & 0xFF;
    const sign  = (v & 0x80) ? -1 : 1;
    const exp   = (v >> 4) & 0x07;
    const mant  = v & 0x0F;
    t[i] = sign * (((mant << 1) | 33) << exp) - sign * 33;
  }
  return t;
})();

/**
 * G.711 μ-law (PCMU) → PCM16 LE
 * @param {Buffer} input  — Buffer com bytes μ-law
 * @returns {Buffer}       — Buffer PCM16 LE (2 bytes por amostra)
 */
function ulawToPcm16(input) {
  const out = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    out.writeInt16LE(ULAW_TO_PCM[input[i]], i * 2);
  }
  return out;
}

/**
 * PCM16 LE → G.711 μ-law (PCMU)
 * @param {Buffer} input  — Buffer PCM16 LE
 * @returns {Buffer}       — Buffer μ-law
 */
function pcm16ToUlaw(input) {
  const out = Buffer.alloc(input.length / 2);
  for (let i = 0; i < out.length; i++) {
    let s = input.readInt16LE(i * 2);
    const sign = s < 0 ? 0x80 : 0;
    if (s < 0) s = -s;
    if (s > 32635) s = 32635;
    s += 0x84;
    let exp = 7;
    for (let e = 0x4000; (s & e) === 0 && exp > 0; e >>= 1, exp--);
    const mant = (s >> (exp + 3)) & 0x0F;
    out[i] = ~(sign | (exp << 4) | mant) & 0xFF;
  }
  return out;
}

/**
 * Resample PCM16: 8000 Hz → 16000 Hz (fator 2x, interpolação linear)
 * Necessário para enviar ao Gemini Live que espera 16kHz
 */
function resample8to16(pcm16) {
  const n = pcm16.length / 2;
  const out = Buffer.alloc(n * 2 * 2); // 2x samples
  for (let i = 0; i < n; i++) {
    const s0 = pcm16.readInt16LE(i * 2);
    const s1 = i + 1 < n ? pcm16.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0,                    i * 4);
    out.writeInt16LE(Math.round((s0 + s1) / 2), i * 4 + 2);
  }
  return out;
}

/**
 * Resample PCM16: 8000 Hz → 24000 Hz (fator 3x, interpolação linear)
 * (mantido para compatibilidade futura)
 */
function resample8to24(pcm16) {
  const n = pcm16.length / 2;
  const out = Buffer.alloc(n * 3 * 2);
  for (let i = 0; i < n; i++) {
    const s0 = pcm16.readInt16LE(i * 2);
    const s1 = i + 1 < n ? pcm16.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0,                              i * 6);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) / 3), i * 6 + 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * 2 / 3), i * 6 + 4);
  }
  return out;
}

/**
 * Resample PCM16: 24000 Hz → 8000 Hz (fator 1/3, decimação)
 * Necessário para enviar de volta ao WaVoIP que espera 8kHz
 */
function resample24to8(pcm16) {
  const n = Math.floor(pcm16.length / 6);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(pcm16.readInt16LE(i * 6), i * 2);
  }
  return out;
}

/**
 * AGC (Automatic Gain Control) — normaliza nível de áudio antes de enviar ao Gemini
 *
 * Problema: usuário no viva-voz gera RMS ~200-500, usuário no ouvido gera ~3000-8000.
 * O Gemini faz VAD sobre esse sinal — sinal muito baixo pode não ser detectado como fala.
 *
 * Lógica:
 *   - Mede RMS do buffer
 *   - Se RMS < limiar de silêncio (100): retorna sem modificar (não amplifica ruído puro)
 *   - Calcula ganho para atingir TARGET_RMS (4000), limitado a MAX_GAIN (6x)
 *   - Aplica ganho com hard-clip para evitar distorção
 *
 * @param {Buffer} pcm16  Buffer PCM16 LE
 * @returns {Buffer}       Buffer PCM16 LE com nível normalizado
 */
function agcNormalize(pcm16) {
  const TARGET_RMS  = 4000;  // nível alvo (confortável para STT)
  const MAX_GAIN    = 6.0;   // nunca amplifica mais de 6x (evita distorção em ruído)
  const NOISE_FLOOR = 100;   // RMS abaixo disso = silêncio — não amplifica

  let sum = 0;
  const n = pcm16.length >> 1; // número de amostras
  for (let i = 0; i < pcm16.length - 1; i += 2) {
    const s = pcm16.readInt16LE(i);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);

  if (rms < NOISE_FLOOR) return pcm16; // silêncio — passa sem modificar

  const gain = Math.min(TARGET_RMS / rms, MAX_GAIN);
  if (gain <= 1.01) return pcm16; // já está no nível certo — não processa

  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length - 1; i += 2) {
    let s = Math.round(pcm16.readInt16LE(i) * gain);
    if (s >  32767) s =  32767;
    if (s < -32767) s = -32767;
    out.writeInt16LE(s, i);
  }
  return out;
}

module.exports = { ulawToPcm16, pcm16ToUlaw, resample8to16, resample8to24, resample24to8, agcNormalize };
