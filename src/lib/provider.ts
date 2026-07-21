// Re-exports shared/keystone-provider.js as-is. The file stays at the repo
// root (not moved into src/) because app/*.html still imports it directly
// during the page-by-page migration; move it into src/ once the last old
// page is deleted, per CLAUDE.md.
export * from '../../shared/keystone-provider.js';
