import tseslint from 'typescript-eslint';

/**
 * 只开“能抓到真实缺陷”的规则，不引入风格争论。
 * 格式交给编辑器/后续 prettier，不在这里争论缩进。
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'runtime/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // 未使用变量是真实缺陷（残留分支、忘记接线的参数）。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 显式 any 会绕过契约校验。
      '@typescript-eslint/no-explicit-any': 'error',
      // 未 await 的 Promise 在调度器/harness 里会导致竞态。
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': ['error', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // 脚本与测试可以输出与放宽
    files: ['scripts/**/*.mjs', '**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
