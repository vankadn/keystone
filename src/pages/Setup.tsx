import { useEffect, useState } from 'react';
import { initializeSheet } from '../lib/provider';
import { requestSignIn, getCachedToken } from '../lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Nav } from '../components/Nav';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Idempotent-repeatable sheet setup — re-run whenever SHEET_SCHEMA gains a
// new tab (Classes, day_sections, day_plan_items, ... have all needed
// this so far), not just once at bootstrap. Now in the Nav for exactly
// that reason — see Nav.tsx for why keeping it out caused a real bug
// (lost sign-in state from reaching it via a fresh browser tab).
export default function Setup() {
  const [status, setStatus] = useState('Not signed in.');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [result, setResult] = useState('');
  const [signInBusy, setSignInBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);

  useEffect(() => {
    const cached = getCachedToken();
    if (cached) {
      setAccessToken(cached);
      setStatus('Signed in (restored). Ready to initialize.');
    }
  }, []);

  async function handleSignIn() {
    setSignInBusy(true);
    try {
      const token = await requestSignIn(window.KEYSTONE_CONFIG.oauthClientId, OAUTH_SCOPE);
      setAccessToken(token);
      setStatus('Signed in. Ready to initialize.');
    } catch (err) {
      setStatus(`Sign-in failed: ${(err as Error).message}`);
    } finally {
      setSignInBusy(false);
    }
  }

  async function handleInitialize() {
    if (!accessToken) {
      setStatus('Sign in first.');
      return;
    }
    setInitBusy(true);
    setStatus('Initializing…');
    setResult('');
    try {
      const outcome = await initializeSheet(window.KEYSTONE_CONFIG.sheetId, accessToken);
      setStatus('Done.');
      setResult(JSON.stringify(outcome, null, 2));
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`);
      console.error(err);
    } finally {
      setInitBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Nav personId={null} />
      <h1 className="text-3xl font-semibold">Setup</h1>
      <Card>
        <CardHeader>
          <CardTitle>Sheet Initialization</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button onClick={handleSignIn} disabled={signInBusy}>
              Sign in
            </Button>
            <Button onClick={handleInitialize} disabled={!accessToken || initBusy} variant="outline">
              Initialize Sheet
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{status}</p>
          {result && <pre className="overflow-auto rounded-md bg-muted p-4 text-xs">{result}</pre>}
        </CardContent>
      </Card>
    </div>
  );
}
