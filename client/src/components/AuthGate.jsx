import { createContext, useContext, useEffect, useState } from 'react';
import { AUTH_ENABLED, subscribeToAuth, signInWithGoogle, signOutUser } from '../lib/auth';
import { getMe } from '../lib/api';
import { useAppStore } from '../lib/store';
import Button from './Button';
import styles from './AuthGate.module.css';

// { email, hosted, signOut } on the hosted site; null in desktop/dev builds.
const AuthContext = createContext(null);
export const useAuthUser = () => useContext(AuthContext);

async function signOutAndReset() {
  await signOutUser();
  // The saved "active instance" belongs to the previous user; drop it and reload
  // so no cached data from their session survives in memory.
  useAppStore.getState().clearConnection();
  window.location.reload();
}

function Card({ title, children }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>◈ Helix Dev Tool</div>
        <div className={styles.title}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function FirebaseGate({ children }) {
  const [state, setState] = useState({ status: 'loading' });
  const [signInError, setSignInError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe;

    subscribeToAuth(async (user) => {
      if (cancelled) return;
      if (!user) return setState({ status: 'signedOut' });

      setState({ status: 'checking', email: user.email });
      try {
        const me = await getMe();           // 403 here = signed in but not on the allowlist
        if (!cancelled) setState({ status: 'ok', email: me.email || user.email, hosted: me.hosted });
      } catch (e) {
        if (cancelled) return;
        setState(e.response?.status === 403
          ? { status: 'denied', email: user.email }
          : { status: 'error', email: user.email, message: e.response?.data?.error || e.message });
      }
    }).then(unsub => { if (cancelled) unsub(); else unsubscribe = unsub; });

    return () => { cancelled = true; unsubscribe?.(); };
  }, []);

  const handleSignIn = async () => {
    setSignInError(null);
    try {
      await signInWithGoogle();
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
        setSignInError(e.message);
      }
    }
  };

  switch (state.status) {
    case 'loading':
    case 'checking':
      return <Card title="Checking your sign-in…" />;

    case 'signedOut':
      return (
        <Card title="Sign in to continue">
          <p className={styles.text}>Access is limited to approved accounts.</p>
          <Button variant="primary" onClick={handleSignIn}>Sign in with Google</Button>
          {signInError && <div className={styles.error}>{signInError}</div>}
        </Card>
      );

    case 'denied':
      return (
        <Card title="Not authorized">
          <p className={styles.text}>
            <strong>{state.email}</strong> isn't on the approved list for this site.
            Ask the site owner to add it, or sign in with a different account.
          </p>
          <Button onClick={signOutAndReset}>Sign out</Button>
        </Card>
      );

    case 'error':
      return (
        <Card title="Something went wrong">
          <div className={styles.error}>{state.message}</div>
          <Button onClick={signOutAndReset}>Sign out</Button>
        </Card>
      );

    default:
      return (
        <AuthContext.Provider value={{ email: state.email, hosted: !!state.hosted, signOut: signOutAndReset }}>
          {children}
        </AuthContext.Provider>
      );
  }
}

export default function AuthGate({ children }) {
  return AUTH_ENABLED ? <FirebaseGate>{children}</FirebaseGate> : children;
}
