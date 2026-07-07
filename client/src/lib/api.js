import axios from 'axios';
import { useAppStore } from './store';

const api = axios.create({ baseURL: '/api' });

// Inject connection ID header for all helix requests
api.interceptors.request.use((config) => {
  if (config.url?.startsWith('/helix')) {
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

// ── Active Links ───────────────────────────────────────────────────────────
export const getActiveLinks = (form) =>
  api.get('/helix/activelinks', { params: form ? { form } : {} }).then(r => r.data);
export const getActiveLink = (name) =>
  api.get(`/helix/activelinks/${encodeURIComponent(name)}`).then(r => r.data);
export const createActiveLink = (def) =>
  api.post('/helix/activelinks', def).then(r => r.data);
export const updateActiveLink = (name, def) =>
  api.put(`/helix/activelinks/${encodeURIComponent(name)}`, def).then(r => r.data);
export const deleteActiveLink = (name) =>
  api.delete(`/helix/activelinks/${encodeURIComponent(name)}`);

// ── Filters ────────────────────────────────────────────────────────────────
export const getFilters = (form) =>
  api.get('/helix/filters', { params: form ? { form } : {} }).then(r => r.data);
export const getFilter = (name) =>
  api.get(`/helix/filters/${encodeURIComponent(name)}`).then(r => r.data);
export const createFilter = (def) =>
  api.post('/helix/filters', def).then(r => r.data);
export const updateFilter = (name, def) =>
  api.put(`/helix/filters/${encodeURIComponent(name)}`, def).then(r => r.data);

// ── Escalations ────────────────────────────────────────────────────────────
export const getEscalations = () =>
  api.get('/helix/escalations').then(r => r.data);
export const getEscalation = (name) =>
  api.get(`/helix/escalations/${encodeURIComponent(name)}`).then(r => r.data);
export const updateEscalation = (name, def) =>
  api.put(`/helix/escalations/${encodeURIComponent(name)}`, def).then(r => r.data);

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
export const getMenus = () =>
  api.get('/helix/menus').then(r => r.data);
export const getMenu = (name) =>
  api.get(`/helix/menus/${encodeURIComponent(name)}`).then(r => r.data);
