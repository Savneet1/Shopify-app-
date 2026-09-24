import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";

/**
 * Auth splat. With Shopify managed installation / token exchange this route
 * simply delegates to the framework, which performs the install/token handshake
 * and establishes the session. No manual OAuth code exchange is required.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};
