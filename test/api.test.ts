import { describe, expect, it } from 'vitest';

import {
	BASE_URL_EXPRESSION,
	DEFAULT_BASE_URL,
	buildAnswerSchema,
	describeApiError,
	parseAnswers,
	resolveBaseUrl,
} from '../nodes/TypeSafeAi/api';

describe('resolveBaseUrl', () => {
	it.each([
		[undefined, 'https://openrouter.ai/api'],
		['', 'https://openrouter.ai/api'],
		['   ', 'https://openrouter.ai/api'],
		['  https://eu.typesafe.ai///  ', 'https://eu.typesafe.ai'],
	])('resolves %s', (raw, expected) => {
		expect(resolveBaseUrl(raw)).toBe(expected);
	});
});

describe('BASE_URL_EXPRESSION', () => {
	it('interpolates the default host rather than shipping the placeholder', () => {
		expect(BASE_URL_EXPRESSION).not.toContain('${');
		expect(BASE_URL_EXPRESSION).toContain(`|| '${DEFAULT_BASE_URL}'`);
	});
});

describe('describeApiError', () => {
	it('flattens a 422 detail list into one sentence', () => {
		const body = {
			detail: [
				{ loc: ['body', 'questions', 'q', 'choice', 'criteria'], msg: 'Field required' },
				{ loc: ['body', 'model'], msg: 'Input should be a valid string' },
			],
		};
		expect(describeApiError(body, 422)).toBe(
			'questions.q.choice.criteria: Field required; model: Input should be a valid string',
		);
	});

	it('uses the message of a detail object', () => {
		const body = { detail: { error_type: 'api_usage_error', message: 'Unknown model: jev-9.9.9' } };
		expect(describeApiError(body, 400)).toBe('Unknown model: jev-9.9.9');
	});

	it('uses a plain text body that did not parse as JSON', () => {
		expect(describeApiError('  Upstream connect error  ', 502)).toBe('Upstream connect error');
	});

	it.each([undefined, '', '   ', '<html><body>502 Bad Gateway</body></html>'])(
		'falls back to the status code given %s',
		(body) => {
			expect(describeApiError(body, 502)).toBe('The OpenRouter API returned status 502');
		},
	);
});

describe('describeApiError for OpenRouter', () => {
	it('uses the message of an OpenRouter error object', () => {
		expect(describeApiError({ error: { message: 'Invalid API key', code: 401 } }, 401)).toBe(
			'Invalid API key',
		);
	});
});

describe('buildAnswerSchema', () => {
	it('builds one strict property per question', () => {
		const schema = buildAnswerSchema({
			team: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: 'B team' } },
			level: { type: 'score', instructions: 'How?', criteria: ['low', 'mid', 'high'] },
			urgent: { type: 'noul', instructions: 'Urgent?' },
		});
		expect(schema).toMatchObject({
			type: 'object',
			required: ['team', 'level', 'urgent'],
			additionalProperties: false,
			properties: {
				team: { properties: { choice: { enum: ['a', 'b'] } }, additionalProperties: false },
				level: { properties: { score: { type: 'integer', enum: [0, 1, 2] } } },
				urgent: { properties: { noul: { type: 'number' } }, required: ['noul'] },
			},
		});
	});

	it('rejects an unknown question type', () => {
		expect(() => buildAnswerSchema({ q: { type: 'rank', instructions: 'x' } })).toThrow(
			/unknown type "rank"/,
		);
	});
});

describe('parseAnswers', () => {
	const questions = {
		team: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } },
		level: { type: 'score', instructions: 'How?', criteria: ['low', 'high'] },
		urgent: { type: 'noul', instructions: 'Urgent?' },
	};

	it('maps the reply onto typed answers', () => {
		const reply = JSON.stringify({
			team: { choice: 'b', confidence: 1.2 },
			level: { score: 1, confidence: 0.6 },
			urgent: { noul: true },
		});
		expect(parseAnswers(questions, reply)).toEqual({
			team: { type: 'choice', choice: 'b', confidence: 1 },
			level: { type: 'score', score: 1, confidence: 0.6, legend: { '0': 'low', '1': 'high' } },
			urgent: { type: 'noul', noul: 1 },
		});
	});

	it('accepts JSON in a code fence', () => {
		const reply =
			'```json\n{"team":{"choice":"a","confidence":0.5},"level":{"score":0,"confidence":0.5},"urgent":{"noul":0.2}}\n```';
		expect(parseAnswers(questions, reply).urgent).toEqual({ type: 'noul', noul: 0.2 });
	});

	it('rejects a choice outside the options', () => {
		const reply = JSON.stringify({
			team: { choice: 'c', confidence: 1 },
			level: { score: 1, confidence: 1 },
			urgent: { noul: 0 },
		});
		expect(() => parseAnswers(questions, reply)).toThrow(/"c", which is not one of its options/);
	});

	it('rejects an empty reply', () => {
		expect(() => parseAnswers(questions, '')).toThrow(/no answer/);
	});
});
