// Storybook interaction tests for the public application shell.
// Follows the established pattern: import stories, delegate to storybookTestRunner
// (same shape as WebstormDashboard.test.tsx / TwoColumnDashboard.test.tsx).
import * as stories from './App.stories';
import { storybookTestRunner } from '@library/test';

describe('App Storybook Interaction Test', () => {
    storybookTestRunner(stories);
});
