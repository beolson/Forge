import {
  createRootRoute,
  HeadContent,
  redirect,
  Scripts,
} from "@tanstack/react-router";
import { getCurrentUser } from "@/lib/auth.functions";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (
      location.pathname === "/auth/error" ||
      location.pathname === "/auth/signed-out"
    ) {
      return { user: null };
    }
    const user = await getCurrentUser();
    if (!user) {
      const returnTo = `${location.pathname}${location.searchStr ?? ""}`;
      throw redirect({
        href: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
      });
    }
    return { user };
  },
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Forge",
      },
      {
        name: "description",
        content: "Forge is a server-rendered foundation for what comes next.",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
