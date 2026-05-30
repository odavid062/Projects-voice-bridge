/**
 * index.js — Servidor principal do voice-bridge
 *
 * API REST (para o n8n chamar):
 *
 *   POST /call
 *   {
 *     "to":           "5562999999999",   // número do cliente (com DDI+DDD)
 *     "leadContext":  "Nome: João. Interesse: automação WhatsApp.",
 *     "systemPrompt": "..."              // opcional, sobrescreve o padrão
 *   }
 *
 *   GET /calls         — lista chamadas ativas
 *   DELETE /call/:id   — encerra chamada específica
 *   GET /health        — status do servidor
 */

require('dotenv').config();
const express     = require('express');
const { v4: uuid } = require('uuid');
const SIPClient   = require('./sip');
const CallSession = require('./session');
const JULIANA_PROMPT = require('./prompt-juliana');

// ── Config ───────────────────────────────────────────────────────────────────

const {
  OPENAI_API_KEY,
  GROQ_API_KEY,
  GEMINI_API_KEY,
  SIP_HOST        = 'sipv2.wavoip.com',
  SIP_PORT        = '5060',
  SIP_USERNAME,
  SIP_PASSWORD,
  LOCAL_IP        = '0.0.0.0',
  HTTP_PORT       = '3000',
  // DEFAULT_SYSTEM_PROMPT: pode ser sobrescrito pelo .env ou pelo campo "systemPrompt" no POST /call
  // Para testes usa o prompt da Juliana; em produção o n8n passa o prompt preenchido via API
  DEFAULT_SYSTEM_PROMPT,
  N8N_WEBHOOK_URL,
} = process.env;

if (!OPENAI_API_KEY && !GEMINI_API_KEY) throw new Error('OPENAI_API_KEY ou GEMINI_API_KEY deve estar definido no .env');
if (!GEMINI_API_KEY) console.warn('[Bridge] GEMINI_API_KEY não definido — usando pipeline OpenAI (fallback)');
if (!SIP_USERNAME)   throw new Error('SIP_USERNAME não definido no .env');
if (!SIP_PASSWORD)   throw new Error('SIP_PASSWORD não definido no .env');

// ── Estado global ─────────────────────────────────────────────────────────────

const activeSessions = new Map(); // sessionId → CallSession

// ── SIP Client ────────────────────────────────────────────────────────────────

const sipClient = new SIPClient({
  host:     SIP_HOST,
  port:     parseInt(SIP_PORT),
  username: SIP_USERNAME,
  password: SIP_PASSWORD,
  localIp:  LOCAL_IP === '0.0.0.0' ? getLocalIP() : LOCAL_IP,
});

sipClient.on('registered', () => {
  console.log('[Bridge] SIP registrado — pronto para chamadas');
});

// ── HTTP API ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    registered:  sipClient.registered,
    activeCalls: activeSessions.size,
    aiMode:      GEMINI_API_KEY ? 'gemini-live' : 'pipeline-openai',
    uptime:      process.uptime(),
  });
});

// GET /calls
app.get('/calls', (req, res) => {
  const calls = [];
  for (const [id, s] of activeSessions) {
    calls.push({
      callId:    id,
      startedAt: s.startedAt,
      duration:  Math.round((Date.now() - s.startedAt) / 1000),
    });
  }
  res.json({ activeCalls: calls.length, calls });
});

// DELETE /call/:id — encerra chamada
app.delete('/call/:id', (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Chamada não encontrada' });
  session.end('api_hangup');
  res.json({ ok: true });
});

// POST /call — inicia uma chamada outbound
app.post('/call', async (req, res) => {
  const { to, leadContext, systemPrompt } = req.body;

  if (!to) return res.status(400).json({ error: '"to" é obrigatório (ex: 5562999999999)' });

  // Evita chamadas duplicadas para o mesmo número
  for (const s of activeSessions.values()) {
    if (s.to === to) {
      return res.status(409).json({ error: `Já existe uma chamada ativa para ${to}` });
    }
  }

  if (!sipClient.registered) {
    return res.status(503).json({ error: 'SIP ainda não registrado, aguarde' });
  }

  const sessionId   = uuid();
  const instructions = buildPrompt(systemPrompt || DEFAULT_SYSTEM_PROMPT || JULIANA_PROMPT, leadContext);

  console.log(`\n[Bridge] ── Nova chamada ──`);
  console.log(`  ID:       ${sessionId}`);
  console.log(`  Para:     ${to}`);
  console.log(`  Contexto: ${leadContext || '(nenhum)'}`);

  try {
    // 1. Cria sessão (apenas abre socket RTP)
    const session = new CallSession({
      callId:    sessionId,
      to,
      openaiKey: OPENAI_API_KEY,
      groqKey:   GROQ_API_KEY,
      geminiKey: GEMINI_API_KEY,
      instructions,
      onEnd: (result) => {
        activeSessions.delete(sessionId);
        notifyN8n(result);
      },
    });

    const rtpPort = await session.start();
    activeSessions.set(sessionId, session);

    // 2. Dispara INVITE — IA só conecta quando a chamada for atendida
    sipClient.call(
      to,
      rtpPort,
      ({ remoteIp, remotePort }) => {
        // Chamada atendida: configura RTP e inicia pipeline IA
        console.log(`[Bridge] ✅ Chamada atendida — iniciando IA`);
        session.setRemoteRTP(remoteIp, remotePort);
      },
      (status) => {
        // Chamada falhou ou encerrada (inclui BYE remoto)
        session.end(`sip_${status}`);
      }
    );

    res.json({ ok: true, callId: sessionId, to });

  } catch (err) {
    console.error('[Bridge] Erro ao iniciar chamada:', err);
    activeSessions.delete(sessionId);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrompt(base, leadContext) {
  if (!leadContext) return base;
  return `${base}\n\nCONTEXTO DO LEAD:\n${leadContext}`;
}

async function notifyN8n(result) {
  if (!N8N_WEBHOOK_URL || N8N_WEBHOOK_URL.includes('seu-n8n')) return;
  try {
    const { default: fetch } = await import('node-fetch').catch(() => ({ default: null }));
    if (!fetch) return;
    await fetch(N8N_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(result),
    });
    console.log('[Bridge] n8n notificado:', result.callId);
  } catch (e) {
    console.warn('[Bridge] Falha ao notificar n8n:', e.message);
  }
}

function getLocalIP() {
  const { networkInterfaces } = require('os');
  for (const iface of Object.values(networkInterfaces())) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return '127.0.0.1';
}

// ── Start ─────────────────────────────────────────────────────────────────────

sipClient.start();

app.listen(parseInt(HTTP_PORT), () => {
  const aiMode = GEMINI_API_KEY ? 'Gemini Live (nativo)' : 'Pipeline OpenAI  ';
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  voice-bridge rodando                ║`);
  console.log(`║  HTTP  → http://localhost:${HTTP_PORT}      ║`);
  console.log(`║  SIP   → ${SIP_HOST}        ║`);
  console.log(`║  IA    → ${aiMode}       ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

process.on('SIGINT', () => {
  console.log('\n[Bridge] Encerrando...');
  for (const s of activeSessions.values()) s.end('shutdown');
  sipClient.stop();
  process.exit(0);
});
