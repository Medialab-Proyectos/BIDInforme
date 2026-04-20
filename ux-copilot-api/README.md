# UX Copilot API

Backend Express para el chatbot del reporte `JourneyMap-SAR-Informe-Semestral.html`.

## Que hace

- Recibe preguntas en `POST /ask-ux`.
- Busca evidencia relevante en BigQuery.
- Construye un prompt con esa evidencia.
- Responde con OpenAI usando el modelo configurado en `OPENAI_MODEL`.

## Configuracion

1. Instala dependencias:

```bash
npm install
```

Si tu `npm` esta apuntando al registry corporativo y no encuentra paquetes publicos, usa:

```bash
npm install --registry=https://registry.npmjs.org/
```

2. Crea el archivo `.env` desde el ejemplo:

```bash
copy .env.example .env
```

3. Completa las variables:

```bash
OPENAI_API_KEY=...
GCP_PROJECT=ux-bid-bot
BQ_DATASET=ux_research
BQ_TABLE=ux_clean_final
```

4. Autentica BigQuery localmente con una de estas opciones:

```bash
gcloud auth application-default login
```

o configura:

```bash
GOOGLE_APPLICATION_CREDENTIALS=C:\ruta\service-account.json
```

5. Inicia el servidor:

```bash
npm run dev
```

Tambien puedes levantarlo desde la raiz del proyecto:

```bash
npm run ux:api
```

El endpoint quedara en `http://localhost:8080/ask-ux`.

## Credenciales de BigQuery en Vercel

Para Vercel no uses `gcloud auth application-default login`, porque el servicio lo consumiran usuarios externos y Vercel no tendra tu sesion local. Usa una service account de Google Cloud y configura estas variables en Vercel Project Settings > Environment Variables:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
GCP_PROJECT=ux-bid-bot
BQ_DATASET=ux_research
BQ_TABLE=ux_clean_final
GOOGLE_CREDENTIALS_JSON={"type":"service_account",...}
CORS_ORIGIN=*
```

`GOOGLE_CREDENTIALS_JSON` puede ser el JSON completo en una sola linea o el contenido del JSON codificado en base64. No subas el archivo `.json` al repo.

Permisos minimos recomendados para la service account:

- `BigQuery Job User` en el proyecto.
- `BigQuery Data Viewer` sobre el dataset o la tabla.

## Deploy en Vercel

Este subproyecto ya incluye `api/index.js` y `vercel.json`, por lo que puedes desplegar `ux-copilot-api` como proyecto de Vercel. Los endpoints publicos quedan:

```bash
https://tu-proyecto.vercel.app/health
https://tu-proyecto.vercel.app/ask-ux
```

## Probar

```bash
curl -X POST http://localhost:8080/ask-ux ^
  -H "Content-Type: application/json" ^
  -d "{\"question\":\"Como mejorar el autoguardado en matriz de resultados?\"}"
```

## Despliegue

El servidor lee `PORT`, por lo que puede desplegarse en Cloud Run. Asegurate de configurar `OPENAI_API_KEY`, `GCP_PROJECT`, `BQ_DATASET`, `BQ_TABLE` y permisos de lectura sobre la tabla de BigQuery.
