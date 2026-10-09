import { createHash } from "node:crypto";

export type LLMMode="replay"|"record"|"live";

export interface LLMRequest {
  model: string;
  stage: string;
  prompt: string;
}
export interface LLMResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  fixtureHit: boolean;
}
