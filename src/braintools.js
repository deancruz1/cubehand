// Tools the brain handles itself instead of the bot's body. They are sent to every model in
// every job, so the tools stay byte-identical when a job moves to another model.
function tool(name, description, properties, required) {
  return {
    name,
    description,
    strict: true,
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  };
}

export const BRAIN_TOOLS = [
  tool(
    'finish',
    'End the job and send message to the player as your final reply. Put it last, in the same response as your last actions, when how they turn out won\'t change what you\'d say. It only happens if every call before it in the response worked; otherwise it comes back as not done and you carry on.',
    { message: { type: 'string' } },
    ['message']
  ),
  tool(
    'escalate',
    'Hand this job to a model that thinks more: normal for everyday jobs, complex for building or anything that needs a plan. Only when the request asks you to sort the job first, and then as the only call in your response. Never otherwise.',
    { to: { type: 'string', enum: ['normal', 'complex'] } },
    ['to']
  )
];
