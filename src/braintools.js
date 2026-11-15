// Tools the brain handles itself instead of the bot's body. They are sent to every model in
// every job, so the tools stay byte-identical when a job moves to another model. standing_job is
// left out when standing.enabled is false.
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
  ),
  tool(
    'standing_job',
    "Work you keep doing until told to stop, in rounds of one unit each that start on their own when nothing else is going on. start only when a player asks for work to go on until told to stop, or to carry on a kind of work on your own, never for a one-off job: task says on its own what to keep doing, where, the pattern, and the limits and rules; progress says where things stand and what the next unit is. Call progress at the end of every round, with task too when a player changes the terms. pause (with reason), resume or end when a player asks, or pause when you can't go on.",
    {
      action: { type: 'string', enum: ['start', 'progress', 'pause', 'resume', 'end'] },
      task: { type: 'string' },
      progress: { type: 'string' },
      reason: { type: 'string' }
    },
    ['action']
  )
];
