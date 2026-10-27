export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot commits keep their own format
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
};
