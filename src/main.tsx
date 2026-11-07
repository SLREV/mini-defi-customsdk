import './polyfills';
import React, { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import App from './App';
import './index.css';

const endpoint = (import.meta.env.VITE_MAINNET_RPC_ENDPOINT as string | undefined)?.trim() || 'https://api.mainnet-beta.solana.com';

function Root(): React.ReactElement {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <App />
      </WalletProvider>
    </ConnectionProvider>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
