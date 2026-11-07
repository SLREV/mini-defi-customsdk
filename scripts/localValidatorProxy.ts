/** Vite-only bridge: browser uses same-origin URLs, server reaches loopback validator. */
export function localValidatorProxy(rpcPort = 8899, websocketPort = 8900) {
  return {
    '/local-validator-rpc': {
      target: `http://127.0.0.1:${rpcPort}`, changeOrigin: true, rewrite: () => '/',
    },
    '/local-validator-ws': {
      target: `ws://127.0.0.1:${websocketPort}`, ws: true, changeOrigin: true, rewrite: () => '/',
    },
  };
}
