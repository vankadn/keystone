import { Link } from 'react-router-dom';

const LINKS = [
  { to: '/', label: 'Today' },
  { to: '/plan-tomorrow', label: 'Plan Tomorrow' },
  { to: '/checkpoints', label: 'Checkpoints' },
  { to: '/report', label: 'Report' },
  { to: '/habits', label: 'Habits' },
  { to: '/classes', label: 'Classes' },
  { to: '/setup', label: 'Setup' },
];

// Setup used to be deliberately excluded here (one-time bootstrap page,
// not daily navigation) — reversed once that stopped being true in
// practice: every new tab added to SHEET_SCHEMA (Classes, day_sections,
// day_plan_items, ...) means "re-run Initialize Sheet" again, and with no
// in-app link to /setup, reaching it meant typing the URL into a fresh
// browser tab — which starts with empty sessionStorage, so the cached
// auth token (see keystone-auth.js) never carried over and sign-in had to
// happen again every time. An in-app <Link> click keeps the same tab/
// session, so the cached token just works. See CLAUDE.md's Architecture
// layers section.
export function Nav({ personId }: { personId: string | null }) {
  const suffix = personId ? `?personId=${personId}` : '';
  return (
    <nav className="flex gap-4 text-sm text-muted-foreground">
      {LINKS.map((link) => (
        <Link key={link.label} to={`${link.to}${suffix}`} className="hover:text-foreground hover:underline">
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
