import type { Config } from "@react-router/dev/config";

export default {
  // Embedded Shopify admin apps are server-rendered (SSR) so that the
  // authentication boundary runs on the server for every navigation.
  ssr: true,
} satisfies Config;
