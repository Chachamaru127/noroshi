import type { ExecutionContext } from '@cloudflare/workers-types';

declare const sveltekit: {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
};

export default sveltekit;
