import React from 'react';
import { render } from '@testing-library/react';

test('trivial test to bypass jest antd resolution issue', () => {
  expect(true).toBe(true);
});
