export default {
  async fetch(request, env) {
    return env.LEDGER.fetch(request);
  },
};
