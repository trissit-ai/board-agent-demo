/**
 * 自治 Board Agent 协同看板 —— 极简静态托管与配置读写服务
 *
 * 约束：仅使用 Node 内置模块；不接模型、不接业务系统、不调用任何外部接口。
 * 职责：托管单文件 index.html、把 config.json 注入页面占位符、提供配置读写 API。
 *
 * 用法：node server.js [port]   或   PORT=4173 node server.js
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT_DIR = __dirname;
const INDEX_FILE = path.join(ROOT_DIR, 'index.html');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

const DEFAULT_PORT = 4173;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024; // 2MB 配置体积上限
const CONFIG_PLACEHOLDER = '__CONFIG_JSON__';

/**
 * 解析监听端口：优先首个命令行参数，其次 PORT 环境变量，最后默认值。
 * @returns {number} 合法端口号
 */
function resolvePort() {
  const raw = process.argv[2] || process.env.PORT || String(DEFAULT_PORT);
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_PORT;
  }
  return parsed;
}

const PORT = resolvePort();

/**
 * 把 JSON 文本安全地嵌入 <script type="application/json"> 中。
 * 转义 < > & 以及行分隔符，防止提前闭合标签或破坏 JSON.parse。
 * @param {string} jsonText 原始 JSON 文本
 * @returns {string} 可安全嵌入的 JSON 文本
 */
function escapeForScriptTag(jsonText) {
  return jsonText
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 发送 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {unknown} payload 响应体
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body, 'utf8');
}

/**
 * 发送 HTML 响应。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {string} html HTML 文本
 */
function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html, 'utf8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(html, 'utf8');
}

/**
 * 发送纯文本错误响应。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {string} message 错误信息
 */
function sendText(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message, 'utf8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(message, 'utf8');
}

/**
 * GET / 与 /index.html：读取页面并注入最新 config.json。
 * 注入失败时降级为不含占位符替换的原始页面，前端会启用内嵌默认配置。
 * @param {import('node:http').ServerResponse} res 响应对象
 */
async function serveIndex(res) {
  try {
    const [html, configText] = await Promise.all([
      fsp.readFile(INDEX_FILE, 'utf8'),
      fsp.readFile(CONFIG_FILE, 'utf8')
    ]);
    const injected = html.includes(CONFIG_PLACEHOLDER)
      ? html.replace(CONFIG_PLACEHOLDER, () => escapeForScriptTag(configText))
      : html;
    sendHtml(res, injected);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendText(res, 404, '未找到 index.html 或 config.json');
      return;
    }
    sendJson(res, 500, { ok: false, error: '读取页面失败：' + String(error && error.message ? error.message : error) });
  }
}

/**
 * GET /api/config：返回当前 config.json 原文。
 * @param {import('node:http').ServerResponse} res 响应对象
 */
async function getConfig(res) {
  try {
    const text = await fsp.readFile(CONFIG_FILE, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text, 'utf8'),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(text, 'utf8');
  } catch (error) {
    sendJson(res, 500, { ok: false, error: '读取配置失败：' + String(error && error.message ? error.message : error) });
  }
}

/**
 * 读取请求体，超过上限立即拒绝。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Buffer>} 请求体
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let oversize = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_CONFIG_BYTES) {
        // 标记超限后继续消费请求体但不缓存，保证能正常返回 413 而不是断开连接。
        oversize = true;
        return;
      }
      if (!oversize) chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversize) {
        reject(Object.assign(new Error('配置体积超过 2MB 上限'), { statusCode: 413 }));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => reject(error));
  });
}

/**
 * PUT /api/config：校验 JSON 后写临时文件并原子替换。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @param {import('node:http').ServerResponse} res 响应对象
 */
async function putConfig(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { ok: false, error: String(error.message || error) });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: '配置不是合法 JSON：' + String(error.message || error) });
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { ok: false, error: '配置根节点必须是 JSON 对象' });
    return;
  }

  // 规范化为带缩进的可读文本，保证人类可手改。
  const normalized = JSON.stringify(parsed, null, 2) + '\n';
  const tmpFile = path.join(ROOT_DIR, '.config.json.tmp-' + process.pid + '-' + Date.now());

  try {
    await fsp.writeFile(tmpFile, normalized, 'utf8');
    await fsp.rename(tmpFile, CONFIG_FILE);
    sendJson(res, 200, { ok: true, bytes: Buffer.byteLength(normalized, 'utf8') });
  } catch (error) {
    try {
      if (fs.existsSync(tmpFile)) await fsp.unlink(tmpFile);
    } catch (cleanupError) {
      // 清理失败不影响主错误返回。
    }
    sendJson(res, 500, { ok: false, error: '写入配置失败：' + String(error && error.message ? error.message : error) });
  }
}

/**
 * 解析并归一化路径，仅允许白名单，阻断路径穿越与任意静态文件读取。
 * @param {string} rawUrl 原始请求 URL
 * @returns {string} 归一化后的路径名
 */
function safePathname(rawUrl) {
  let decoded = '/';
  try {
    const url = new URL(rawUrl, 'http://localhost');
    decoded = decodeURIComponent(url.pathname);
  } catch (error) {
    return '/__invalid__';
  }
  // 统一分隔符并移除连续斜杠，防止 /../ 与编码变体。
  let normalized = decoded.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.includes('..') || normalized.includes('\u0000')) {
    return '/__invalid__';
  }
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || '/';
}

/**
 * 请求分发。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @param {import('node:http').ServerResponse} res 响应对象
 */
async function handle(req, res) {
  const pathname = safePathname(req.url || '/');
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'board-agent-demo', port: PORT });
    return;
  }

  if (pathname === '/api/config') {
    if (method === 'GET') {
      await getConfig(res);
      return;
    }
    if (method === 'PUT') {
      await putConfig(req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: '仅支持 GET 与 PUT' });
    return;
  }

  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    await serveIndex(res);
    return;
  }

  // 静态资源只允许 index.html；其余一律 404，不暴露任何本地文件。
  sendText(res, 404, '未找到资源：仅提供 index.html 与 /api/* 接口');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
    } else {
      res.end();
    }
  });
});

server.on('error', (error) => {
  process.stderr.write('[board-agent-demo] 服务启动失败：' + String(error.message || error) + '\n');
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = 'http://127.0.0.1:' + PORT + '/';
  process.stdout.write('[board-agent-demo] 服务已启动\n');
  process.stdout.write('[board-agent-demo] 页面地址: ' + addr + '\n');
  process.stdout.write('[board-agent-demo] 健康检查: ' + addr + 'api/health\n');
  process.stdout.write('[board-agent-demo] 配置接口: ' + addr + 'api/config\n');
  process.stdout.write('[board-agent-demo] 数据真源: ' + CONFIG_FILE + '\n');
  process.stdout.write('[board-agent-demo] 只读配置服务：不接模型、不接业务系统、不调用外部接口\n');
});
