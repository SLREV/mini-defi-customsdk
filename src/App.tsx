import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PhantomWalletName } from '@solana/wallet-adapter-phantom';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  CustomDefiSDK, DeserializedPoolInfo, NATIVE_SOL_MINT, TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID, calculateSwapOutput, parseTokenAmount,
} from './sdk/customSdk';
import { formatExactTokenAmount, readSwapTokenBalance } from './tradeUtils';
import { assertMainnet, launchRentAccountSizes, sendMainnetTransaction } from './mainnet';

const label = 'mb-1 block text-xs font-medium text-zinc-300';
const input = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100';
const button = 'rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40';
const card = 'rounded-xl border border-zinc-800 bg-zinc-900/60 p-5';
const computeUnits = 1_400_000;

function configuredProgramId(): PublicKey | null {
  try {
    const value = (import.meta.env.VITE_MAINNET_AMM_PROGRAM_ID as string | undefined)?.trim();
    return value ? new PublicKey(value) : null;
  } catch { return null; }
}

export default function App(): React.ReactElement {
  const { connection } = useConnection();
  const { publicKey, connected, connecting, wallet, select, connect, disconnect, sendTransaction } = useWallet();
  const programId = useMemo(configuredProgramId, []);
  const sdk = useMemo(() => programId ? new CustomDefiSDK(connection, programId) : null, [connection, programId]);
  const [networkStatus, setNetworkStatus] = useState('Memeriksa RPC dan program…');
  const [networkReady, setNetworkReady] = useState(false);
  const [networkRevision, setNetworkRevision] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceRevision, setBalanceRevision] = useState(0);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Hubungkan Phantom untuk menggunakan mainnet.');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const beginAction = (): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); return true;
  };
  const endAction = (): void => { busyRef.current = false; setBusy(false); };
  const [signature, setSignature] = useState('');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [authorityAcknowledged, setAuthorityAcknowledged] = useState(false);
  const [authority, setAuthority] = useState({ mint: false, freeze: false, metadata: false });
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [imageUri, setImageUri] = useState('');
  const [metadataUri, setMetadataUri] = useState('');
  const [telegram, setTelegram] = useState('');
  const [twitter, setTwitter] = useState('');
  const [supply, setSupply] = useState('1000000000');
  const [virtualSol, setVirtualSol] = useState('30');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [pool, setPool] = useState<DeserializedPoolInfo | null>(null);
  const [mintInput, setMintInput] = useState('');
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('1');
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => { if (!wallet) select(PhantomWalletName); }, [wallet, select]);
  useEffect(() => {
    let cancelled = false;
    setNetworkReady(false);
    if (!programId) {
      setNetworkStatus('Isi VITE_MAINNET_AMM_PROGRAM_ID dengan program AMM yang sudah di-deploy di mainnet.');
      return;
    }
    setNetworkStatus('Memeriksa RPC dan program…');
    void assertMainnet(connection, programId).then(() => {
      if (!cancelled) { setNetworkReady(true); setNetworkStatus('Mainnet dan akun program executable terdeteksi. Binary belum diverifikasi oleh dashboard.'); }
    }).catch((err: unknown) => { if (!cancelled) setNetworkStatus(err instanceof Error ? err.message : 'Pemeriksaan mainnet gagal'); });
    return () => { cancelled = true; };
  }, [connection, programId, networkRevision]);
  useEffect(() => {
    let cancelled = false;
    setBalance(null);
    if (publicKey && networkReady) void connection.getBalance(publicKey, 'confirmed')
      .then((value) => { if (!cancelled) setBalance(value); })
      .catch(() => { if (!cancelled) setBalance(null); });
    return () => { cancelled = true; };
  }, [publicKey, connection, networkReady, balanceRevision]);
  useEffect(() => {
    let cancelled = false;
    setTokenBalance(null);
    if (pool && publicKey && networkReady) void readSwapTokenBalance(connection, publicKey, pool.tokenY, pool.tokenProgramY)
      .then((value) => { if (!cancelled) setTokenBalance(value); })
      .catch(() => { if (!cancelled) setTokenBalance(null); });
    return () => { cancelled = true; };
  }, [pool, publicKey, connection, networkReady, balanceRevision]);
  useEffect(() => { setRiskAccepted(false); setPool(null); setSignature(''); }, [publicKey]);

  const report = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const activePayer = (): PublicKey => {
    if (!publicKey || !connected || !wallet?.adapter.publicKey?.equals(publicKey)) throw new Error('Hubungkan wallet Phantom yang benar.');
    if (!riskAccepted) throw new Error('Konfirmasi risiko mainnet terlebih dahulu.');
    if (!sdk || !programId || !networkReady) throw new Error('RPC atau program mainnet belum siap.');
    return publicKey;
  };

  // Only the wallet adapter signs and sends. mintKeypair is an additional, ephemeral
  // signer solely for the new mint account; the SDK never receives secret keys.
  const dispatch = async (tx: Transaction, signers: Keypair[], sizes: number[], transfer = 0n): Promise<string> => {
    const payer = activePayer();
    const result = await sendMainnetTransaction(connection, programId!, payer, tx, signers, sizes, transfer, sendTransaction,
      () => { if (!wallet?.adapter.publicKey?.equals(payer)) throw new Error('Wallet berubah. Hubungkan ulang.'); },
      (required) => setStatus(`Estimasi minimum ${(Number(required) / 1e9).toFixed(6)} SOL termasuk cadangan. Menunggu persetujuan wallet…`),
      (sent) => { setSignature(sent); setStatus(`Transaksi ${sent} dikirim; menunggu konfirmasi…`); },
    );
    setBalanceRevision((n) => n + 1);
    return result;
  };

  const launch = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault(); if (!beginAction()) return; setError(''); setSignature(''); setPool(null);
    let attemptedMint = '';
    try {
      const payer = activePayer();
      if ((!authority.mint || !authority.freeze || !authority.metadata) && !authorityAcknowledged) {
        throw new Error('Konfirmasi bahwa authority OFF bersifat permanen.');
      }
      const total = parseTokenAmount(supply, 9);
      const virtualX = parseTokenAmount(virtualSol, 9);
      if (total <= 0n || virtualX <= 0n) throw new Error('Supply dan virtual SOL harus lebih besar dari nol.');
      await assertMainnet(connection, programId!);
      const mintKeypair = Keypair.generate();
      const mint = await sdk!.buildCloneTokenInstructions({
        mint: mintKeypair.publicKey, payer, name, symbol, imageUri, metadataUri: metadataUri.trim() || undefined,
        telegram, twitter, decimals: 9, initialSupplyRaw: total, tokenStandard: 'TOKEN_2022', authorities: authority,
      });
      const poolBuild = await sdk!.buildCreatePoolTx({
        payer, tokenX: NATIVE_SOL_MINT, tokenY: mint.mint, initialRealTokenY: total, virtualReservesX: virtualX,
        tokenProgramX: TOKEN_PROGRAM_ID, tokenProgramY: TOKEN_2022_PROGRAM_ID, tokenProgramLp: TOKEN_2022_PROGRAM_ID,
      });
      // Mint instructions already create the same associated token account.
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), ...mint.instructions, poolBuild.instruction);
      attemptedMint = mint.mint.toBase58();
      setMintInput(attemptedMint);
      await dispatch(tx, [mintKeypair], launchRentAccountSizes(mint.allocatedMintBytes));
      setStatus(`Mint dan pool terkonfirmasi di mainnet: ${attemptedMint}`);
      try { setPool(await sdk!.fetchPoolInfo(poolBuild.addresses.poolState)); }
      catch { setStatus(`Transaksi terkonfirmasi. Gagal membaca pool; muat ulang menggunakan mint ${attemptedMint}.`); }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(attemptedMint ? `${detail} Mint yang dicoba: ${attemptedMint}. Periksa status sebelum mengulang.` : detail);
    } finally { endAction(); }
  };

  const loadPool = async (): Promise<void> => {
    if (!beginAction()) return; setError('');
    try {
      if (!sdk || !programId || !networkReady) throw new Error('Program mainnet belum siap.');
      await assertMainnet(connection, programId);
      const info = await sdk.fetchPoolInfo(NATIVE_SOL_MINT, new PublicKey(mintInput.trim()));
      const mintAccount = await connection.getAccountInfo(info.tokenY, 'confirmed');
      if (!mintAccount || !mintAccount.owner.equals(info.tokenProgramY) || mintAccount.data.length < 82 || mintAccount.data[44] !== 9) throw new Error('Dashboard hanya mendukung mint token dengan 9 desimal.');
      setPool(info); setStatus(`Pool ${info.poolAddress.toBase58()} dimuat dari mainnet.`);
    } catch (err) { report(err); } finally { endAction(); }
  };

  const quote = useMemo(() => {
    if (!pool) return null;
    try {
      const raw = parseTokenAmount(amount, 9);
      const slip = Number(slippage);
      if (!Number.isFinite(slip) || slip < 0 || slip > 50 || !/^\d+(\.\d{1,2})?$/.test(slippage)) return null;
      const out = calculateSwapOutput(raw, side === 'BUY' ? pool.totalReservesX : pool.totalReservesY, side === 'BUY' ? pool.totalReservesY : pool.totalReservesX);
      if (out > (side === 'BUY' ? pool.realReservesY : pool.realReservesX)) return null;
      const bps = BigInt(Math.round(slip * 100));
      const minOut = out * (10_000n - bps) / 10_000n;
      return minOut > 0n ? { raw, out, minOut } : null;
    } catch { return null; }
  }, [amount, pool, side, slippage]);

  const executeSwap = async (): Promise<void> => {
    if (!beginAction()) return; setError(''); setSignature('');
    try {
      const payer = activePayer();
      if (!pool || !quote) throw new Error('Jumlah atau estimasi swap tidak valid.');
      const current = await sdk!.fetchPoolInfo(pool.poolAddress);
      const actualOut = calculateSwapOutput(quote.raw, side === 'BUY' ? current.totalReservesX : current.totalReservesY, side === 'BUY' ? current.totalReservesY : current.totalReservesX);
      if (actualOut < quote.minOut || actualOut > (side === 'BUY' ? current.realReservesY : current.realReservesX)) {
        setPool(current); throw new Error('Harga atau likuiditas berubah; periksa estimasi baru sebelum mencoba lagi.');
      }
      if (side === 'SELL' && quote.raw > await readSwapTokenBalance(connection, payer, current.tokenY, current.tokenProgramY)) throw new Error('Saldo token tidak mencukupi.');
      const built = await sdk!.buildSwapTx({
        user: payer, tokenX: current.tokenX, tokenY: current.tokenY, amountIn: quote.raw,
        minAmountOut: quote.minOut, xToY: side === 'BUY', tokenProgramX: current.tokenProgramX,
        tokenProgramY: current.tokenProgramY, unwrapWsol: side === 'SELL',
      });
      built.transaction.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
      await dispatch(built.transaction, [], [170, 170], side === 'BUY' ? quote.raw : 0n);
      setStatus('Swap terkonfirmasi.');
      try { setPool(await sdk!.fetchPoolInfo(current.poolAddress)); } catch { setStatus('Swap terkonfirmasi, tetapi pool gagal diperbarui.'); }
    } catch (err) { report(err); } finally { endAction(); }
  };

  const claimFee = async (): Promise<void> => {
    if (!beginAction()) return; setError(''); setSignature('');
    try {
      const payer = activePayer();
      if (!pool || !pool.creator.equals(payer)) throw new Error('Hanya creator pool dapat mengklaim fee.');
      const claim = await sdk!.buildClaimCreatorFeeTx({ creator: payer, tokenX: pool.tokenX, tokenY: pool.tokenY, tokenProgramX: pool.tokenProgramX, tokenProgramY: pool.tokenProgramY });
      await dispatch(claim.transaction, [], [170, 170]);
      setStatus('Klaim fee creator terkonfirmasi.');
      try { setPool(await sdk!.fetchPoolInfo(pool.poolAddress)); } catch { setStatus('Klaim terkonfirmasi, tetapi pool gagal diperbarui.'); }
    } catch (err) { report(err); } finally { endAction(); }
  };

  const sellAll = async (): Promise<void> => {
    if (!beginAction()) return; setError('');
    try {
      const payer = activePayer(); if (!pool) throw new Error('Pool belum dimuat.');
      const raw = await readSwapTokenBalance(connection, payer, pool.tokenY, pool.tokenProgramY);
      setTokenBalance(raw); setSide('SELL'); setAmount(formatExactTokenAmount(raw));
    } catch (err) { report(err); } finally { endAction(); }
  };

  const uploadImage = async (file: File): Promise<void> => {
    setUploadBusy(true); setError('');
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('Gagal membaca gambar.')); reader.readAsDataURL(file);
      });
      const response = await fetch('/api/pinata/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: file.name, base64, name, symbol, telegram, twitter }) });
      const body = await response.json() as { imageUri?: string; metadataUri?: string; error?: string; detail?: string };
      if (!response.ok || !body.imageUri || !body.metadataUri) throw new Error(body.detail ?? body.error ?? 'Upload gagal');
      setImageUri(body.imageUri); setMetadataUri(body.metadataUri); setStatus('Gambar dan metadata diunggah.');
    } catch (err) { report(err); } finally { setUploadBusy(false); }
  };

  return <div className="min-h-screen bg-zinc-950 text-zinc-100">
    <header className="border-b border-zinc-800 px-5 py-4"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
      <div><h1 className="font-semibold">Mini DeFi Token Launchpad &amp; AMM</h1><p className="text-xs text-rose-300">MAINNET BETA · SOL nyata · tidak ada simulasi</p></div>
      <div className="flex items-center gap-3 text-xs"><span>{balance === null ? '—' : (balance / 1e9).toFixed(6)} SOL</span>
        {connected ? <button className={button} disabled={busy} onClick={() => void disconnect().catch(report)}>Putuskan {publicKey?.toBase58().slice(0, 8)}…</button> :
          <button className={button} disabled={busy || connecting || !wallet} onClick={() => void connect().catch(report)}>{connecting ? 'Menghubungkan…' : 'Hubungkan Phantom'}</button>}
      </div>
    </div></header>
    <main className="mx-auto max-w-6xl space-y-4 px-5 py-5">
      <div className="rounded-lg border border-rose-500/50 bg-rose-950/40 p-4 text-xs text-rose-100">
        <strong>MAINNET RIIL.</strong> Transaksi memakai dana nyata, tidak bisa dibatalkan, dan belum diaudit. Tidak ada fitur remove liquidity. Mematikan authority permanen tidak menjamin bebas rug pull.
        <p className="mt-2 break-all">Program ID: {programId?.toBase58() ?? 'belum diatur'} · {networkStatus} <button type="button" onClick={() => setNetworkRevision((n) => n + 1)} className="underline">Periksa ulang</button></p>
        <label className="mt-2 flex gap-2"><input type="checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} disabled={busy} /> Saya memahami bahwa transaksi ini menggunakan SOL asli.</label>
      </div>
      <div className={card}><p role="status" className="break-all text-xs">{status}</p>{error && <p role="alert" className="mt-2 break-all text-xs text-rose-300">{error}</p>}{signature && <a className="mt-2 block break-all text-xs text-cyan-300 underline" href={`https://explorer.solana.com/tx/${signature}`} target="_blank" rel="noreferrer">Lihat transaksi {signature}</a>}</div>
      <div className="grid gap-4 lg:grid-cols-2">
        <form className={`${card} space-y-3`} onSubmit={(e) => void launch(e)}>
          <h2 className="font-semibold">Launch token &amp; virtual pool</h2><p className="text-xs text-zinc-400">Mint dan pool dalam satu transaksi. Tidak ada setoran SOL riil awal; rent dan fee tetap dibayar.</p>
          <div className="grid grid-cols-2 gap-3"><div><label className={label} htmlFor="name">Nama</label><input id="name" className={input} value={name} onChange={(e) => setName(e.target.value)} required /></div><div><label className={label} htmlFor="symbol">Ticker</label><input id="symbol" className={input} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} required /></div></div>
          <div><label className={label} htmlFor="image">Image URI</label><input id="image" className={input} value={imageUri} onChange={(e) => setImageUri(e.target.value)} required /></div>
          <div><label className={label} htmlFor="metadata">Metadata JSON URI (opsional)</label><input id="metadata" className={input} value={metadataUri} onChange={(e) => setMetadataUri(e.target.value)} /></div>
          <div><label className={label} htmlFor="upload">Upload gambar via Pinata (dev server)</label><input id="upload" type="file" accept="image/*" disabled={uploadBusy || busy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadImage(file); e.target.value = ''; }} className="text-xs" />{uploadBusy && <span className="text-xs"> Mengunggah…</span>}</div>
          <div className="grid grid-cols-2 gap-3"><div><label className={label} htmlFor="telegram">Telegram (opsional)</label><input id="telegram" className={input} value={telegram} onChange={(e) => setTelegram(e.target.value)} /></div><div><label className={label} htmlFor="twitter">Twitter (opsional)</label><input id="twitter" className={input} value={twitter} onChange={(e) => setTwitter(e.target.value)} /></div></div>
          <p className="text-xs text-amber-300">Transaksi gabungan maksimum 1.232 byte. Jika terlalu besar, pendekkan nama, URI, atau metadata sosial.</p>
          <div className="grid grid-cols-2 gap-3"><div><label className={label} htmlFor="supply">Supply</label><input id="supply" className={input} value={supply} onChange={(e) => setSupply(e.target.value)} /></div><div><label className={label} htmlFor="virtual">Virtual SOL</label><input id="virtual" className={input} value={virtualSol} onChange={(e) => setVirtualSol(e.target.value)} /></div></div>
          <fieldset className="space-y-2 rounded-lg border border-zinc-700 p-3" disabled={busy}><legend className="text-xs">Authority token baru</legend>
            {(['mint', 'freeze', 'metadata'] as const).map((key) => <label key={key} className="flex justify-between gap-2 text-xs"><span>{key === 'metadata' ? 'Metadata update + pointer' : key === 'mint' ? 'Mint authority' : 'Freeze authority'}</span><span><input type="checkbox" checked={authority[key]} onChange={(e) => { setAuthority((v) => ({ ...v, [key]: e.target.checked })); setAuthorityAcknowledged(false); }} /> {authority[key] ? 'ON' : 'OFF'}</span></label>)}
            <p className="text-xs text-amber-300">OFF permanen. Konten eksternal HTTPS tetap bisa berubah.</p><label className="flex gap-2 text-xs"><input type="checkbox" checked={authorityAcknowledged} onChange={(e) => setAuthorityAcknowledged(e.target.checked)} /> Saya memahami authority OFF permanen.</label>
          </fieldset><button className={`${button} w-full`} disabled={busy || !networkReady || !connected || !riskAccepted || uploadBusy}>Launch via wallet</button>
        </form>
        <section className="space-y-4"><div className={`${card} space-y-3`}><h2 className="font-semibold">Pool &amp; mint</h2><label className={label} htmlFor="mint">Alamat mint</label><div className="flex gap-2"><input id="mint" className={input} value={mintInput} onChange={(e) => { setMintInput(e.target.value); setPool(null); setCopyStatus(''); }} /><button type="button" className={button} onClick={() => { void navigator.clipboard.writeText(mintInput).then(() => setCopyStatus('Mint disalin')).catch(() => setCopyStatus('Pilih dan salin alamat secara manual.')); }}>Copy Mint</button></div><p className="text-xs">{copyStatus}</p><button type="button" className={button} disabled={busy || !networkReady} onClick={() => void loadPool()}>Muat pool</button>
          {pool && <div className="space-y-1 break-all text-xs text-zinc-300"><p>Pool: {pool.poolAddress.toBase58()}</p><p>SOL riil: {formatExactTokenAmount(pool.realReservesX)}</p><p>SOL virtual: {formatExactTokenAmount(pool.virtualReservesX)}</p><p>Token riil: {formatExactTokenAmount(pool.realReservesY)}</p><p>Saldo ATA Anda: {tokenBalance === null ? '—' : formatExactTokenAmount(tokenBalance)}</p><p>Fee creator: {formatExactTokenAmount(pool.creatorFeeX)} SOL + {formatExactTokenAmount(pool.creatorFeeY)} token</p><button type="button" className={button} disabled={busy || !connected || !riskAccepted || !pool.creator.equals(publicKey ?? PublicKey.default)} onClick={() => void claimFee()}>Claim fee</button></div>}
        </div>
        <div className={`${card} space-y-3`}><h2 className="font-semibold">Swap</h2><div className="flex gap-2"><button type="button" className={button} onClick={() => setSide('BUY')}>Beli SOL → token</button><button type="button" className={button} onClick={() => setSide('SELL')}>Jual token → SOL</button></div><p className="text-xs">Sisi: {side}</p><label className={label} htmlFor="amount">Jumlah {side === 'BUY' ? 'SOL' : 'token'}</label><input id="amount" className={input} value={amount} onChange={(e) => setAmount(e.target.value)} /><button type="button" className={button} disabled={busy || !pool || !connected || !riskAccepted} onClick={() => void sellAll()}>SELL ALL</button><label className={label} htmlFor="slippage">Slippage maksimum (%)</label><input id="slippage" className={input} value={slippage} onChange={(e) => setSlippage(e.target.value)} /><p className="text-xs text-zinc-300">Estimasi output: {quote ? formatExactTokenAmount(quote.out) : '—'} · Minimum: {quote ? formatExactTokenAmount(quote.minOut) : '—'}</p><p className="text-xs text-amber-300">Jual menutup ATA WSOL dan mencairkan seluruh saldo WSOL ATA tersebut ke SOL. Pool dengan cadangan SOL riil kecil dapat menolak penjualan.</p><button type="button" className={button} disabled={busy || !connected || !networkReady || !riskAccepted || !quote} onClick={() => void executeSwap()}>{side === 'BUY' ? 'Beli' : 'Jual'} via wallet</button></div></section>
      </div>
    </main>
  </div>;
}
