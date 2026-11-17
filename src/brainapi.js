// The call to the API for a job's step, what each model takes in it, and the log of a refused one.
import { createHash } from 'node:crypto';
import { withoutPictureData } from './brainpictures.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Smaller models reject the strict grammar once there are many tools, and only the bigger ones
// have the server-side refusal fallback.
const isSmallModel = (model) => /haiku/.test(model);
const hasFallback = (model) => /opus|fable|mythos/.test(model);
export const strictTools = (claude, model) => claude.strictTools && !isSmallModel(model);
// Models that take a role: "system" message partway through the conversation.
export const hasSystemMessages = (model) => /opus-5|opus-4-8|fable|mythos|sonnet-5-5|haiku-5-5/.test(model);

// Methods of the Brain class, put on it in brain.js, so this is the brain.
export const apiMethods = {
  // With claude.streaming on, the answer streams in and onEvent(event, message so far) hears each
  // part of it. Either way this resolves with the whole message.
  createMessage(messages, signal, effort = this.config.claude.effort, model = this.config.claude.model, onEvent = null, maxTokens = this.config.claude.maxTokens) {
    const { claude } = this.config;
    const params = {
      model,
      max_tokens: maxTokens,
      system: this.systemBlocks,
      tools: strictTools(claude, model) ? this.tools : this.looseTools,
      messages,
      output_config: { effort },
      cache_control: { type: 'ephemeral' }
    };
    if (claude.fallback && hasFallback(model)) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }
    if (claude.streaming !== true) return this.client.beta.messages.create(params, { signal });
    const stream = this.client.beta.messages.stream(params, { signal });
    if (onEvent) stream.on('streamEvent', onEvent);
    // A refusal keeps the id of its request, as one from create() does, for the log.
    return stream.finalMessage().then((message) => {
      if (message?.stop_reason === 'refusal' && !message._request_id && stream.request_id) {
        try {
          Object.defineProperty(message, '_request_id', { value: stream.request_id, configurable: true });
        } catch {}
      }
      return message;
    });
  },

  // One console line for a refused step, and its full request in the refusal log. Returns the
  // refusal's category.
  noteRefusal(response, messages, model, effort, lean = false) {
    const details = response.stop_details ?? null;
    const category = details?.category ?? null;
    const by = response.model ?? model;
    const requestId = response._request_id ?? null;
    const path = this.refusalLog?.write({
      at: new Date().toISOString(),
      model: by,
      requestId,
      stopDetails: details,
      usage: response.usage ?? null,
      content: response.content,
      request: {
        model,
        effort,
        lean,
        fallbacks: Boolean(this.config.claude.fallback && hasFallback(model)),
        strictTools: strictTools(this.config.claude, model),
        system: { length: this.system.length, sha256: createHash('sha256').update(this.system).digest('hex') },
        tools: this.tools.map((t) => t.name),
        messages: withoutPictureData(messages)
      }
    });
    this.log(
      `[brain] refusal from ${by}: output ${response.usage?.output_tokens ?? 0}, category ${category ?? 'none'}` +
        `${details?.explanation ? ` (${details.explanation})` : ''}, request ${requestId ?? 'unknown'}${path ? `, saved to ${path}` : ''}`
    );
    return category;
  },

  logUsage(step, usage) {
    if (!usage) return;
    this.log(
      `[claude] step ${step}: input ${usage.input_tokens}, cache read ${usage.cache_read_input_tokens ?? 0}, ` +
        `cache write ${usage.cache_creation_input_tokens ?? 0}, output ${usage.output_tokens}`
    );
  }
};
