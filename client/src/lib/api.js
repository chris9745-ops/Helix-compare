import axios from 'axios';
import { useAppStore } from './store';
import { AUTH_ENABLED, getIdToken } from './auth';

const api = axios.create({ baseURL: '/api' });

// Hosted site: attach the signed-in user's Firebase ID token to every API call.
// (Desktop/dev builds have AUTH_ENABLED=false and skip this entirely.)
api.interceptors.request.use(async (config) => {
  if (AUTH_ENABLED) {
    const token = await getIdToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Inject connection ID header for all helix requests — unless the caller
// already set one explicitly (e.g. Compare's per-side connection pickers,
// which aren't tied to the sidebar's global instance selector).
api.interceptors.request.use((config) => {
  if (config.url?.startsWith('/helix') && !config.headers['X-Connection-Id']) {
    const id = useAppStore.getState().activeConnectionId;
    if (id) config.headers['X-Connection-Id'] = id;
  }
  return config;
});

// ── Who am I (also tells the sign-in gate whether this account is allowed) ──
export const getMe = () => api.get('/me').then(r => r.data);

// ── Connections ────────────────────────────────────────────────────────────
export const getConnections = () => api.get('/connections').then(r => r.data);
export const createConnection = (data) => api.post('/connections', data).then(r => r.data);
export const updateConnection = (id, data) => api.put(`/connections/${id}`, data).then(r => r.data);
export const deleteConnection = (id) => api.delete(`/connections/${id}`);
export const testConnection = (id) => api.post(`/connections/${id}/test`).then(r => r.data);

// ── Forms ──────────────────────────────────────────────────────────────────
// BMC's REST API can't list every form on a server — only fetch the fields of a
// form you name.
export const getFormFields = (formName) =>
  api.get(`/helix/forms/${encodeURIComponent(formName)}/fields`).then(r => r.data);

// ── Imported form list (pasted from the Mid-Tier "AR System Object List") ────
export const getFormList = (connId) =>
  api.get(`/connections/${connId}/forms`).then(r => r.data);
export const importFormList = (connId, text) =>
  api.put(`/connections/${connId}/forms`, { text }).then(r => r.data);
export const clearFormList = (connId) =>
  api.delete(`/connections/${connId}/forms`);

// ── Menus ──────────────────────────────────────────────────────────────────
// No bulk-list endpoint — lookup by exact known menu name only.
export const getMenu = (name) =>
  api.get(`/helix/menus/${encodeURIComponent(name)}`).then(r => r.data);

// ── Companies (per explicit connection, not the sidebar's global one) ──────
export const getCompanies = (connId) =>
  api.get('/helix/companies', { headers: { 'X-Connection-Id': connId } }).then(r => r.data);

// ── Compare (Dev vs Prod) ────────────────────────────────────────────────────
export const compareData = ({ leftConnId, rightConnId, formName, keyField, qLeft, qRight, fields }) =>
  api.post('/compare/data', { leftConnId, rightConnId, formName, keyField, qLeft, qRight, fields }).then(r => r.data);

export const compareFields = ({ leftConnId, rightConnId, formName, keyField }) =>
  api.post('/compare/fields', { leftConnId, rightConnId, formName, keyField }).then(r => r.data);

// ── Workflow (Active Links / Filters / Escalations) — desktop app only ─────────
// Goes through the native AR API via the BMC Client Gateway; REST can't see these objects.
export const getWorkflowStatus = () => api.get('/workflow/status').then(r => r.data);
export const getWorkflowForms = (connId) =>
  api.get(`/workflow/${connId}/forms`).then(r => r.data.forms);
export const getFormWorkflow = (connId, form) =>
  api.get(`/workflow/${connId}/form-workflow`, { params: { form } }).then(r => r.data);
export const searchWorkflow = (connId, kind, q) =>
  api.get(`/workflow/${connId}/search`, { params: { kind, q } }).then(r => r.data);
export const getWorkflowObject = (connId, kind, name) =>
  api.get(`/workflow/${connId}/object`, { params: { kind, name } }).then(r => r.data);

// ── Diagnostics ────────────────────────────────────────────────────────────
// `forms` is an optional comma-separated list of form names to probe instead
// of the default set.
export const runDiagnostic = (forms) =>
  api.get('/helix/diagnostic', { params: forms ? { forms } : {} }).then(r => r.data);
