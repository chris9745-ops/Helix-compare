import axios from 'axios';
import { useAppStore } from './store';

const api = axios.create({ baseURL: '/api' });

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

// ── Connections ────────────────────────────────────────────────────────────
export const getConnections = () => api.get('/connections').then(r => r.data);
export const createConnection = (data) => api.post('/connections', data).then(r => r.data);
export const updateConnection = (id, data) => api.put(`/connections/${id}`, data).then(r => r.data);
export const deleteConnection = (id) => api.delete(`/connections/${id}`);
export const testConnection = (id) => api.post(`/connections/${id}/test`).then(r => r.data);

// ── Forms ──────────────────────────────────────────────────────────────────
export const getForms = () =>
  api.get('/helix/forms').then(r => r.data);
export const getFormSchema = (formName) =>
  api.get(`/helix/forms/${encodeURIComponent(formName)}`).then(r => r.data);
export const getFormFields = (formName) =>
  api.get(`/helix/forms/${encodeURIComponent(formName)}/fields`).then(r => r.data);
export const createField = (formName, def) =>
  api.post(`/helix/forms/${encodeURIComponent(formName)}/fields`, def).then(r => r.data);
export const updateField = (formName, fieldId, def) =>
  api.put(`/helix/forms/${encodeURIComponent(formName)}/fields/${fieldId}`, def).then(r => r.data);

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
