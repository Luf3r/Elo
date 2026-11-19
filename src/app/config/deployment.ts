import { z } from 'zod';

declare const __ELO_DEPLOYMENT__: unknown;

const TENANT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const originSchema = z.string().transform((value, ctx) => {
  if (/\s/.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid origin.' });
    return z.NEVER;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid origin.' });
    return z.NEVER;
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (value !== parsed.origin && value !== `${parsed.origin}/`)
  ) {
    ctx.addIssue({ code: 'custom', message: 'Invalid origin.' });
    return z.NEVER;
  }
  return parsed.origin;
});

const deploymentSchema = z.strictObject({
  origin: originSchema,
  ownerEmail: z.email(),
  tenantKey: z.string().regex(TENANT_KEY_PATTERN),
  allowedInboxIds: z
    .array(z.number().int().positive().refine(Number.isSafeInteger))
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length),
  // Optional; staging sets true so no client can obtain CRM write or automation processing scopes.
  readOnly: z.boolean().optional(),
});

export interface DeploymentConfig {
  readonly origin: string;
  readonly ownerEmail: string;
  readonly tenantKey: string;
  readonly allowedInboxIds: readonly number[];
  readonly readOnly: boolean;
}

function readRawDeployment(): unknown {
  if (typeof __ELO_DEPLOYMENT__ !== 'undefined') {
    return __ELO_DEPLOYMENT__;
  }
  return (globalThis as { __ELO_DEPLOYMENT__?: unknown }).__ELO_DEPLOYMENT__;
}

function parseDeployment(raw: unknown): DeploymentConfig {
  const parsed = deploymentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Deployment configuration is missing or invalid.');
  }
  return Object.freeze({
    origin: parsed.data.origin,
    ownerEmail: parsed.data.ownerEmail,
    tenantKey: parsed.data.tenantKey,
    allowedInboxIds: Object.freeze([...parsed.data.allowedInboxIds]),
    readOnly: parsed.data.readOnly ?? false,
  });
}

/** Validated, immutable deployment configuration injected at build or startup. */
export const DEPLOYMENT: DeploymentConfig = parseDeployment(readRawDeployment());
