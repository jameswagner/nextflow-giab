module.exports = {
  testEnvironment: 'node',
  // Prefer TypeScript sources: stale compiled .js files next to them (build output, git-ignored) must never win.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  }
};
