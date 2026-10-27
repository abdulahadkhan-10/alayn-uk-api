import { isCodingRequest } from '../src/modules/ai/guardrails';

describe('AlaynAI question filter', () => {
  // Everyday café questions that happen to contain "techy" words must get through
  it.each([
    'Should I start a loyalty program for regulars?',
    'Create a loyalty program for our weekday customers',
    'What discount code should I run this weekend?',
    'Give me a promo code idea for Diwali',
    'How did customers react to the new discount code?',
    'Is our Java Chip Frappe selling well?',
    'We have a private function on Saturday, how much extra milk do we need?',
    'Should I add ruby chocolate cake to the menu?',
    'Which class of items has the most waste?',
    'Should I import coffee beans from a new supplier?',
    'Can you write a social media post for our new menu?',
    'How will my sales look next week?',
    'Which items are low in stock?',
    'What is the HSN code for coffee?',
    'Write a script for my staff to greet customers',
  ])('allows: %s', (q) => {
    expect(isCodingRequest(q)).toBe(false);
  });

  // Clear requests for software work are still turned away
  it.each([
    'Write a Python script to calculate my sales',
    'Give me JavaScript code for a booking website',
    'write code to sort numbers',
    'Can you write a SQL query for my orders table?',
    'Explain this: def total(x): return sum(x)',
    'Write a Java program that prints hello',
    'Help me debug my app',
    'What is the syntax for a for loop in TypeScript?',
    'teach me programming',
    'Show me the source code for a POS system',
    '```const x = 1```',
  ])('blocks: %s', (q) => {
    expect(isCodingRequest(q)).toBe(true);
  });
});
