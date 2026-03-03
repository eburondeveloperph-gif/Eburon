
/**
 * Eburon Standard - Core Logic for Rebranding, Whitelisting, and Logging
 */

export enum Capability {
  LLM = 'llm',
  VISION = 'vision',
  TTS = 'tts',
  STT = 'stt',
  EMBED = 'embed'
}

export interface AliasModel {
  id: string; // <capability>/<alias>_<family>-<version>
  capability: Capability;
  alias: string;
  family: string;
  version: string;
  upstream: {
    provider: string;
    model: string;
  };
  status: 'active' | 'deprecated';
}

export const ALIAS_REGISTRY: AliasModel[] = [
  {
    id: 'llm/codemax_pro-3.1',
    capability: Capability.LLM,
    alias: 'codemax',
    family: 'pro',
    version: '3.1',
    upstream: {
      provider: 'google',
      model: 'gemini-3.1-pro-preview'
    },
    status: 'active'
  },
  {
    id: 'llm/codemax_flash-3.0',
    capability: Capability.LLM,
    alias: 'codemax',
    family: 'flash',
    version: '3.0',
    upstream: {
      provider: 'google',
      model: 'gemini-3-flash-preview'
    },
    status: 'active'
  },
  {
    id: 'llm/codemax_realtime-2025-06-03',
    capability: Capability.LLM,
    alias: 'codemax',
    family: 'realtime',
    version: '2025-06-03',
    upstream: {
      provider: 'openai',
      model: 'gpt-4o-realtime-preview-2025-06-03'
    },
    status: 'active'
  },
  {
    id: 'vision/vision_flash-2.5',
    capability: Capability.VISION,
    alias: 'vision',
    family: 'flash',
    version: '2.5',
    upstream: {
      provider: 'google',
      model: 'gemini-2.5-flash-image'
    },
    status: 'active'
  },
  {
    id: 'tts/echo_multilingual-v2',
    capability: Capability.TTS,
    alias: 'echo',
    family: 'multilingual',
    version: 'v2',
    upstream: {
      provider: 'elevenlabs',
      model: 'eleven_multilingual_v2'
    },
    status: 'active'
  }
];

export interface WhitelistRule {
  rule_id: string; // wl.<scope>.<subject>.<resource>.<action>.<target>.<mode>
  enabled: boolean;
  match: {
    scope: 'global' | 'ws' | 'env' | 'app';
    subject: string; // 'any' or 'role:name' or 'user:id'
    capability: Capability;
    action: string;
    model_pattern: string; // e.g. 'llm/codemax_*'
  };
  effect: 'allow' | 'deny';
  limits?: {
    rpm?: number;
    tpm?: number;
    max_output_tokens?: number;
    max_session_seconds?: number;
  };
  audit?: {
    created_at: string;
    created_by: string;
  };
}

export const DEFAULT_RULES: WhitelistRule[] = [
  {
    rule_id: 'wl.global.any.llm.chat.llm/codemax_*.allow',
    enabled: true,
    match: {
      scope: 'global',
      subject: 'any',
      capability: Capability.LLM,
      action: 'chat',
      model_pattern: 'llm/codemax_*'
    },
    effect: 'allow',
    limits: {
      rpm: 60,
      tpm: 120000
    },
    audit: {
      created_at: '2026-03-03T00:00:00Z',
      created_by: 'system'
    }
  },
  {
    rule_id: 'wl.global.any.vision.generate.vision/vision_*.allow',
    enabled: true,
    match: {
      scope: 'global',
      subject: 'any',
      capability: Capability.VISION,
      action: 'generate',
      model_pattern: 'vision/vision_*'
    },
    effect: 'allow',
    audit: {
      created_at: '2026-03-03T00:00:00Z',
      created_by: 'system'
    }
  },
  {
    rule_id: 'wl.global.any.tts.synth.tts/echo_*.allow',
    enabled: true,
    match: {
      scope: 'global',
      subject: 'any',
      capability: Capability.TTS,
      action: 'synth',
      model_pattern: 'tts/echo_*'
    },
    effect: 'allow',
    audit: {
      created_at: '2026-03-03T00:00:00Z',
      created_by: 'system'
    }
  }
];

export enum EburonErrorCode {
  KEY_MISSING = 'EBRN_KEY_MISSING',
  KEY_INVALID = 'EBRN_KEY_INVALID',
  ALIAS_UNKNOWN = 'EBRN_ALIAS_UNKNOWN',
  WL_NO_MATCH = 'EBRN_WL_NO_MATCH',
  WL_DENY = 'EBRN_WL_DENY',
  RATE_LIMIT = 'EBRN_RATE_LIMIT',
  UPSTREAM_ERROR = 'EBRN_UPSTREAM_ERROR',
  TIMEOUT = 'EBRN_TIMEOUT',
  INTERNAL = 'EBRN_INTERNAL'
}

export const ERROR_MAPPING: Record<EburonErrorCode, { http: number; ui: string }> = {
  [EburonErrorCode.KEY_MISSING]: { http: 401, ui: 'API Key Missing' },
  [EburonErrorCode.KEY_INVALID]: { http: 401, ui: 'Invalid Key' },
  [EburonErrorCode.ALIAS_UNKNOWN]: { http: 400, ui: 'Unknown Model' },
  [EburonErrorCode.WL_NO_MATCH]: { http: 403, ui: 'Not Allowed' },
  [EburonErrorCode.WL_DENY]: { http: 403, ui: 'Not Allowed' },
  [EburonErrorCode.RATE_LIMIT]: { http: 429, ui: 'Rate Limited' },
  [EburonErrorCode.UPSTREAM_ERROR]: { http: 502, ui: 'Provider Error' },
  [EburonErrorCode.TIMEOUT]: { http: 504, ui: 'Timeout' },
  [EburonErrorCode.INTERNAL]: { http: 500, ui: 'Server Error' }
};

export function logEburonEvent(event: any) {
  // In a real app, this would send to a logging service
  console.log('[EBURON_LOG]', JSON.stringify({
    ts: new Date().toISOString(),
    ...event
  }));
}

export function evaluatePolicy(aliasId: string, action: string, subject: string = 'any'): { allowed: boolean; rule?: WhitelistRule; error?: EburonErrorCode } {
  const model = ALIAS_REGISTRY.find(m => m.id === aliasId);
  if (!model) return { allowed: false, error: EburonErrorCode.ALIAS_UNKNOWN };

  // Simple pattern matching for model_pattern
  const matchPattern = (pattern: string, id: string) => {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(id);
  };

  const matchedRule = DEFAULT_RULES.find(rule => 
    rule.enabled &&
    rule.match.capability === model.capability &&
    rule.match.action === action &&
    matchPattern(rule.match.model_pattern, aliasId) &&
    (rule.match.subject === 'any' || rule.match.subject === subject)
  );

  if (!matchedRule) return { allowed: false, error: EburonErrorCode.WL_NO_MATCH };
  
  return { 
    allowed: matchedRule.effect === 'allow', 
    rule: matchedRule,
    error: matchedRule.effect === 'deny' ? EburonErrorCode.WL_DENY : undefined
  };
}
