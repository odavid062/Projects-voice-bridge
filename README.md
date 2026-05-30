# voice-bridge

Bridge entre telefonia SIP/RTP (WaVoIP) e Google Gemini Live API para agentes de voz com IA em ligações telefônicas reais.

## O que faz

Recebe uma requisição HTTP com destino e prompt, faz uma ligação via SIP/WaVoIP, e conecta o áudio da chamada em tempo real ao Gemini Live — criando um agente de voz que fala e ouve por telefone.

## Arquitetura

```
n8n / API externa
      │
      ▼ POST /call
  Express (HTTP)
      │
      ▼
  SIPClient ──REGISTER/INVITE──► WaVoIP (sipv2.wavoip.com)
      │                                │
      │                           RTP UDP Audio
      │                                │
      ▼                                ▼
 CallSession ◄──────────────── RTPHandler (porta dinâmica)
      │
      ▼ PCM16 @16kHz
 RealtimeClient (Gemini Live WebSocket)
      │
      ▼ PCM16 @24kHz → resample → PCMU @8kHz → RTP → WaVoIP → telefone
```

### Pipeline de áudio

| Direção | Conversão |
|---|---|
| Entrada (usuário → IA) | PCMU@8kHz → PCM16@8kHz → AGC → PCM16@16kHz → Gemini Live |
| Saída (IA → usuário) | PCM16@24kHz → PCM16@8kHz → PCMU@8kHz → RTP → WaVoIP |

## Pré-requisitos

- Node.js 18+
- Conta WaVoIP com número SIP ativo
- Chave da API Google Gemini (acesso ao Gemini Live / `gemini-2.0-flash-live-001`)
- Porta UDP 5060 (SIP) e portas RTP (10000-20000) liberadas no firewall
- IP público fixo ou VPS (o WaVoIP precisa rotear RTP de volta)

## Instalação

```bash
git clone https://github.com/seu-usuario/voice-bridge.git
cd voice-bridge
npm install
```

## Configuração

Crie o arquivo `.env` na raiz do projeto:

```env
# SIP / WaVoIP
SIP_HOST=sipv2.wavoip.com
SIP_PORT=5060
SIP_USERNAME=seu-usuario-wavoip
SIP_PASSWORD=sua-senha-wavoip
LOCAL_IP=seu-ip-publico

# Google Gemini Live
GEMINI_API_KEY=sua-chave-gemini

# OpenAI (pipeline fallback, opcional)
OPENAI_API_KEY=sua-chave-openai

# Groq (STT rápido no fallback, opcional)
GROQ_API_KEY=sua-chave-groq

# Servidor HTTP
PORT=3000
```

## Uso

```bash
# Produção
npm start

# Desenvolvimento (auto-reload)
npm run dev
```

### Disparar uma chamada

```bash
curl -X POST http://localhost:3000/call \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5562999999999",
    "systemPrompt": "Você é a Juliana, atendente da imobiliária Criáte..."
  }'
```

**Parâmetros:**

| Campo | Tipo | Descrição |
|---|---|---|
| `to` | string | Número de destino (formato E.164 sem +) |
| `systemPrompt` | string | Prompt do agente (opcional — usa prompt padrão se omitido) |

**Resposta:**

```json
{
  "callId": "uuid-da-chamada",
  "status": "calling"
}
```

### Encerrar uma chamada

```bash
curl -X DELETE http://localhost:3000/call/{callId}
```

### Status

```bash
curl http://localhost:3000/status
```

## Estrutura do projeto

```
voice-bridge/
├── src/
│   ├── index.js          # Servidor HTTP + orquestração de chamadas
│   ├── sip.js            # Cliente SIP UDP (REGISTER, INVITE, ACK, BYE)
│   ├── rtp.js            # Handler RTP (envio/recepção de pacotes de áudio)
│   ├── session.js        # Sessão ativa: pipeline RTP ↔ Gemini Live
│   ├── realtime.js       # Cliente WebSocket Gemini Live BidiGenerateContent
│   ├── codec.js          # G.711 μ-law ↔ PCM16 + resampling + AGC
│   └── prompt-juliana.js # Prompt de exemplo: atendente imobiliária (voz)
├── .env                  # Credenciais (não commitar)
├── .gitignore
├── package.json
└── README.md
```

## Funcionalidades

- **SIP Digest Auth (MD5)** — REGISTER e INVITE com autenticação completa
- **Codec G.722** — oferece wideband na negociação SDP; detecta se WaVoIP aceita
- **AGC (Automatic Gain Control)** — normaliza nível de entrada antes de enviar ao Gemini
- **Resampling linear** — 8kHz ↔ 16kHz ↔ 24kHz sem dependências nativas
- **Echo suppression** — bloqueia envio de áudio ao Gemini enquanto a IA está falando
- **Re-REGISTER automático** — renova registro SIP a cada 50 minutos
- **Transcrição** — loga falas do usuário e da IA; retorna no callback `onEnd`
- **VAD configurável** — usa VAD server-side do Gemini (END_SENSITIVITY_HIGH)

## Notas de latência

Com Gemini Live, a latência típica de resposta é **2–4 segundos** medida da última palavra do usuário até o início do áudio da IA. Isso se deve ao buffer de saída do Gemini (~960ms) somado à latência de rede Brasil→EUA (~400ms).

Para latência abaixo de 1 segundo, considere usar **VAPI** com Deepgram STT + GPT-4o-mini + Azure TTS (pipeline paralelo com ~600–800ms total).

## Licença

MIT
