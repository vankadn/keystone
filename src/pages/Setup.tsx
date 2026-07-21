import { useState } from 'react';
import { initializeSheet } from '../lib/provider';
import { requestSignIn } from '../lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// One-time (idempotent-repeatable) sheet setup — not in the daily Nav,
// same as the old app/setup.html. Whoever bootstraps a bring-your-own
// sheet hits this page first.
export default function Setup() {
  const [status, setStatus] = useState('Not signed in.');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [result, setResult] = useState('');
  const [signInBusy, setSignInBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);

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
