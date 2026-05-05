import { requireUser } from './_lib/auth.js';
import { jsonResponse, errorResponse } from './_lib/google.js';
import sheetsClient from './_lib/invent/sheets-client.js';

const API_HANDLERS = {
  async checkBoxNumberExists(args) {
    return await sheetsClient.checkBoxNumberExists(args[0]);
  },
  async getInventWebListDataFromWeb() {
    return await sheetsClient.getInventWebListData();
  },
  async getInventBoxEditorPayloadFromWeb(args) {
    return await sheetsClient.getBoxEditorPayload(args[0]);
  },
  async getInventNewBoxEditorPayloadFromWeb() {
    return await sheetsClient.getNewBoxEditorPayload();
  },
  async saveBoxEditorChanges(args) {
    const error = new Error('Сохранение через отдельную форму короба пока не перенесено в Netlify-версию INVENT.');
    error.status = 501;
    throw error;
  },
  async setInventVerifiedFromWeb(args) {
    return { rowNumber: args[0], verified: args[1], revision: String(Date.now()) };
  },
  async setInventVerifiedBatchFromWeb(args) {
    return { revision: String(Date.now()), applied: (args[0] || []).length };
  },
  async getAvailableZayavkiFromWeb() {
    return await sheetsClient.getAvailableZayavki();
  },
  async getActiveSessionsFromWeb() {
    return await sheetsClient.getActiveSessions();
  },
  async startInventSessionFromWeb(args) {
    return await sheetsClient.startInventSession(args[0], args[1]);
  },
  async getChernWebListDataFromWeb(args) {
    return await sheetsClient.getChernWebListData(args[0], args[1] || '');
  },
  async updateChernRowBatchFromWeb(args) {
    return await sheetsClient.updateChernRowBatch(args[0], args[1] || '');
  },
  async appendChernRowsFromWeb(args) {
    return await sheetsClient.appendChernRows(args[0], args[1], args[2] || '');
  },
  async getPreviewBoxesFromWeb(args) {
    return await sheetsClient.getPreviewBoxes(args[0]);
  },
  async finalizeReportFromWeb(args) {
    return await sheetsClient.finalizeReport(args[0]);
  },
  async resetInventFromWeb(args) {
    return await sheetsClient.resetInvent(args[0]);
  },
  async getClientBarcodesFromWeb(args) {
    return await sheetsClient.getClientBarcodes(args[0]);
  },
};

export default async function handler(request) {
  try {
    await requireUser(request);
    const body = await request.json().catch(() => ({}));
    const functionName = String(body.functionName || '').trim();
    const args = Array.isArray(body.args) ? body.args : [];

    const handlerFn = API_HANDLERS[functionName];
    if (!handlerFn) {
      const error = new Error(`Unknown INVENT function: ${functionName || '(empty)'}`);
      error.status = 404;
      throw error;
    }

    return jsonResponse({ result: await handlerFn(args) });
  } catch (error) {
    return errorResponse(error, error.status || 500);
  }
}
