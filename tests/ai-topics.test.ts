import { detectTopics } from '../src/modules/ai/aiContext';

const topics = (text: string) => [...detectTopics(text)].sort();

describe('AlaynAI question topics (decides which café data is sent)', () => {
  it.each([
    ['How will my sales look next week?', ['sales']],
    ['How much did I sell last Tuesday?', ['sales']],
    ['What are my busiest hours?', ['sales']],
    ['Who is on shift today and has everyone clocked in?', ['staff']],
    ['Is anyone on leave tomorrow?', ['staff']],
    ['Which items are low in stock?', ['stock']],
    ['What is expiring this week?', ['stock']],
    ['Where is our waste coming from?', ['stock']],
    ['Which dishes have the best margin?', ['menu']],
    ['Is our Java Chip Frappe popular?', ['menu']],
    ['Do I have enough staff for the busiest day this week?', ['sales', 'staff']],
    ['Which best sellers are running low on stock?', ['menu', 'stock']],
  ])('%s', (q, expected) => {
    expect(topics(q)).toEqual(expected);
  });

  it('sends everything for a general question', () => {
    expect(topics('How is the business doing?')).toEqual(['menu', 'sales', 'staff', 'stock']);
    expect(topics('Give me a summary')).toEqual(['menu', 'sales', 'staff', 'stock']);
  });
});
