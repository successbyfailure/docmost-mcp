const { URL } = require('url');

class DocmostClient {
  constructor({ baseUrl, apiToken }) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.authCookie = null;
  }

  buildAuthHeaders(extra = {}) {
    const headers = { ...extra };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    } else if (this.authCookie) {
      headers.Cookie = `authToken=${this.authCookie}`;
    }
    return headers;
  }

  async request(path, options = {}) {
    const url = new URL(path, this.baseUrl).toString();
    const headers = this.buildAuthHeaders({
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    });

    const response = await fetch(url, { ...options, headers });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const message = typeof body === 'string' ? body : JSON.stringify(body);
      throw new Error(`Docmost devolvió ${response.status}: ${message}`);
    }

    if (contentType.includes('text/html') || (typeof body === 'string' && body.toLowerCase().includes('<!doctype html'))) {
      throw new Error('Docmost devolvió HTML en lugar de JSON. Revisa que la ruta API sea correcta.');
    }

    if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'data')) {
      return body.data;
    }

    return body;
  }

  async post(path, body) {
    return this.request(path, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    });
  }

  listSpaces() {
    return this.post('/api/spaces', { page: 1, limit: 50 });
  }

  async listPages(spaceId) {
    if (!spaceId) {
      throw new Error('spaceId es obligatorio para listar páginas.');
    }
    const items = [];
    let page = 1;
    let hasNext = true;
    let lastMeta = null;

    while (hasNext) {
      const result = await this.post('/api/pages/sidebar-pages', { spaceId, page });
      const pageItems = result?.items || [];
      items.push(...pageItems);
      lastMeta = result?.meta || null;
      hasNext = Boolean(lastMeta?.hasNextPage);
      page += 1;
    }

    return { items, meta: lastMeta };
  }

  getPage(pageId) {
    if (!pageId) {
      throw new Error('pageId es obligatorio para obtener una página.');
    }
    return this.post('/api/pages/info', { pageId });
  }

  searchPages(query) {
    if (!query) {
      throw new Error('query es obligatorio para buscar.');
    }
    return this.post('/api/search', { query });
  }

  createPage(payload) {
    const { title, content, spaceId, folderId } = payload || {};
    if (!title || !content || !spaceId) {
      throw new Error('title, content y spaceId son obligatorios para crear una página.');
    }

    return this.post('/api/pages/create', {
      title,
      content,
      spaceId,
      parentPageId: folderId || null,
    });
  }

  updatePage(pageId, payload) {
    if (!pageId) {
      throw new Error('pageId es obligatorio para actualizar una página.');
    }
    return this.post('/api/pages/update', { pageId, ...(payload || {}) });
  }

  async getParentPage(pageId) {
    const page = await this.getPage(pageId);
    const parentId = page?.parentPageId || page?.parentPage?.id || page?.parentId || null;
    if (!parentId) {
      return { parentId: null, parent: null };
    }
    const parent = await this.getPage(parentId);
    return { parentId, parent };
  }

  async listChildren(pageId) {
    const page = await this.getPage(pageId);
    const spaceId = page?.spaceId || page?.space?.id || page?.space?.spaceId;
    if (!spaceId) {
      throw new Error('No se pudo determinar spaceId para buscar hijos.');
    }
    const pages = await this.listPages(spaceId);
    const items = (pages?.items || pages || []).filter((item) => {
      const parent = item.parentPageId || item.parentId || item.parentPage?.id;
      return parent === pageId;
    });
    return { parentPageId: pageId, items };
  }

  async downloadFile(fileId) {
    if (!fileId) throw new Error('fileId es obligatorio para descargar.');
    const url = new URL(`/api/files/${fileId}`, this.baseUrl).toString();
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildAuthHeaders(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Docmost devolvió ${response.status} al descargar: ${text}`);
    }
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return {
      fileId,
      contentType,
      size: buffer.length,
      base64: buffer.toString('base64'),
    };
  }

  async uploadFile({ pageId, fileName, fileBase64, fileUrl }) {
    if (!pageId) throw new Error('pageId es obligatorio para subir un archivo.');
    if (!fileBase64 && !fileUrl) {
      throw new Error('Proporciona fileBase64 o fileUrl para subir un archivo.');
    }

    let buffer;
    let name = fileName || 'upload.bin';
    let contentType = 'application/octet-stream';

    if (fileUrl) {
      const downloadRes = await fetch(fileUrl);
      if (!downloadRes.ok) {
        const text = await downloadRes.text();
        throw new Error(`No se pudo obtener el archivo remoto: ${downloadRes.status} ${text}`);
      }
      contentType = downloadRes.headers.get('content-type') || contentType;
      const arr = await downloadRes.arrayBuffer();
      buffer = Buffer.from(arr);
      if (!fileName) {
        const urlParts = new URL(fileUrl);
        name = urlParts.pathname.split('/').pop() || name;
      }
    } else {
      buffer = Buffer.from(fileBase64, 'base64');
    }

    const formData = new FormData();
    formData.append('pageId', pageId);
    formData.append('file', new Blob([buffer], { type: contentType }), name);

    const url = new URL('/api/files/upload', this.baseUrl).toString();
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildAuthHeaders(),
      body: formData,
    });

    const contentTypeResponse = response.headers.get('content-type') || '';
    const body = contentTypeResponse.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const message = typeof body === 'string' ? body : JSON.stringify(body);
      throw new Error(`Docmost devolvió ${response.status} al subir archivo: ${message}`);
    }

    return body;
  }

  async login(email, password) {
    if (!email || !password) {
      throw new Error('email y password son obligatorios para autenticarse.');
    }

    const url = new URL('/api/auth/login', this.baseUrl).toString();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      const message = typeof body === 'string' ? body : JSON.stringify(body);
      throw new Error(`Docmost devolvió ${response.status} al iniciar sesión: ${message}`);
    }

    const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie');
    const cookies = Array.isArray(rawCookies)
      ? rawCookies
      : rawCookies
        ? [rawCookies]
        : [];

    const authCookie = cookies.find((cookie) => cookie.startsWith('authToken='));
    if (!authCookie) {
      throw new Error('No se pudo obtener la cookie authToken desde Docmost.');
    }

    const token = authCookie.split(';')[0].split('=')[1];
    if (!token) {
      throw new Error('No se pudo extraer el valor de authToken.');
    }

    this.authCookie = token;
    return token;
  }
}

module.exports = { DocmostClient };
