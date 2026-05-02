import http from 'node:http';
import Busboy from '@fastify/busboy';

const PORT = Number(process.env.PORT || 8788);
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const STT_PROXY_TOKEN = String(process.env.STT_PROXY_TOKEN || '').trim();
const OPENAI_STT_UPSTREAM_URL = String(
  process.env.OPENAI_STT_UPSTREAM_URL || 'https://api.openai.com/v1/audio/transcriptions',
).trim();
const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB || 50);
const MAX_AUDIO_BYTES = MAX_AUDIO_MB * 1024 * 1024;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res, status, text) {
  const body = String(text || '');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

async function readMultipart(req) {
  return await new Promise((resolve, reject) => {
    const fields = new Map();
    let fileMeta = null;
    let fileTruncated = false;
    const chunks = [];

    const busboy = new Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: MAX_AUDIO_BYTES,
      },
    });

    busboy.on('field', (name, value) => {
      fields.set(name, value);
    });

    busboy.on('file', (fieldname, stream, filename, encoding, mimetype) => {
      fileMeta = { fieldname, filename, encoding, mimetype };
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('limit', () => {
        fileTruncated = true;
      });
    });

    busboy.on('filesLimit', () => {
      reject(Object.assign(new Error('Chỉ hỗ trợ 1 file audio mỗi lần'), { statusCode: 400 }));
    });

    busboy.on('error', reject);

    busboy.on('finish', () => {
      if (!fileMeta) {
        reject(Object.assign(new Error('Thiếu file audio trong multipart/form-data'), { statusCode: 400 }));
        return;
      }
      if (fileTruncated) {
        reject(Object.assign(new Error(`File quá lớn — tối đa ${MAX_AUDIO_MB}MB`), { statusCode: 413 }));
        return;
      }
      resolve({
        fields,
        file: {
          ...fileMeta,
          buffer: Buffer.concat(chunks),
        },
      });
    });

    req.pipe(busboy);
  });
}

async function forwardToOpenAI({ fields, file }) {
  const form = new FormData();
  const fileName = file.filename || 'audio.webm';
  const mimeType = file.mimetype || 'application/octet-stream';
  const blob = new Blob([file.buffer], { type: mimeType });
  form.append(file.fieldname || 'file', new File([blob], fileName, { type: mimeType }), fileName);

  for (const [key, value] of fields.entries()) {
    if (value == null || value === '') continue;
    form.append(key, value);
  }

  if (!fields.get('model')) {
    form.append('model', 'gpt-4o-mini-transcribe');
  }
  if (!fields.get('response_format')) {
    form.append('response_format', 'json');
  }

  return await fetch(OPENAI_STT_UPSTREAM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'stt-proxy',
        upstream: OPENAI_STT_UPSTREAM_URL,
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/stt') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    if (!OPENAI_API_KEY) {
      sendJson(res, 500, { error: 'Missing OPENAI_API_KEY' });
      return;
    }

    if (STT_PROXY_TOKEN) {
      const token = getBearerToken(req);
      if (token !== STT_PROXY_TOKEN) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('multipart/form-data')) {
      sendJson(res, 415, { error: 'Expected multipart/form-data' });
      return;
    }

    const payload = await readMultipart(req);
    const upstream = await forwardToOpenAI(payload);
    const responseText = await upstream.text();

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    });
    res.end(responseText);
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    console.error('STT proxy error:', error);
    if (statusCode >= 400 && statusCode < 500) {
      sendJson(res, statusCode, { error: error.message || 'Bad request' });
      return;
    }
    sendText(res, 500, 'Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`STT proxy listening on http://0.0.0.0:${PORT}`);
});
