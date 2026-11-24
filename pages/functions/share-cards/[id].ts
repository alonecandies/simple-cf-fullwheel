import type { PagesEnvironment } from "../types";

export const onRequest: PagesFunction<PagesEnvironment> = ({ request, env }) =>
  env.APP.fetch(request);
