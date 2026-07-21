import { Link } from 'react-router-dom';

const LINKS = [
  { to: '/', label: 'Today' },
  { to: '/plan-tomorrow', label: 'Plan Tomorrow' },
  { to: '/checkpoints', label: 'Checkpoints' },
  { to: '/report', label: 'Report' },
];

// Setup isn't in here — it's a one-time bootstrap page, not part of daily
// navigation, matching the old app/setup.html's design.
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
