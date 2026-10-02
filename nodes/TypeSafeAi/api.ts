import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const CREDENTIAL_NAME = 'openRouterApi';
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api';
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

/** Limits on on a question's criteria */
export const OPTION_BOUNDS = { min: 2, max: 255 };
export const LEVEL_BOUNDS = { min: 2, max: 10 };

export function resolveBaseUrl(raw: unknown): string {
	const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
	return trimmed === '' ? DEFAULT_BASE_URL : trimmed;
}

/** The same resolution as resolveBaseUrl, for the declarative credential test */
export const BASE_URL_EXPRESSION = `={{ ($credentials.url || '').trim().replace(/\\/+$/, '') || '${DEFAULT_BASE_URL}' }}`;

export type QuestionType = 'choice' | 'noul' | 'score';

export interface ModelCard {
	id: string;
	name?: string;
	description?: string;
	created?: number;
}

export interface ChoiceAnswer {
	type: 'choice';
	choice: string;
	confidence?: number;
	probabilities?: Record<string, number>;
}

export interface NoulAnswer {
	type: 'noul';
	noul: number;
}

export interface ScoreAnswer {
	type: 'score';
	score: number;
	confidence?: number;
	legend?: Record<string, string>;
	probabilities?: Record<string, number>;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface SystemOneResponse {
	model: string;
	answers: Record<string, Answer>;
	usage?: IDataObject;
}

function describeValidationIssue(issue: unknown): string {
	const { loc, msg } = (issue ?? {}) as { loc?: unknown[]; msg?: unknown };
	const field = Array.isArray(loc) ? loc.filter((part) => part !== 'body').join('.') : '';
	const message = typeof msg === 'string' ? msg : 'is invalid';
	return field === '' ? message : `${field}: ${message}`;
}

export function describeApiError(body: unknown, statusCode: number): string {
	const error = (body as { error?: unknown } | null | undefined)?.error;
	if (typeof error === 'string' && error !== '') {
		return error;
	}
	const errorMessage = (error as { message?: unknown } | null | undefined)?.message;
	if (typeof errorMessage === 'string' && errorMessage !== '') {
		return errorMessage;
	}
	const detail = (body as { detail?: unknown } | null | undefined)?.detail;
	if (Array.isArray(detail) && detail.length > 0) {
		return detail.map(describeValidationIssue).join('; ');
	}
	if (typeof detail === 'string' && detail !== '') {
		return detail;
	}
	const message = (detail as { message?: unknown } | null | undefined)?.message;
	if (typeof message === 'string' && message !== '') {
		return message;
	}
	if (typeof body === 'string' && body.trim() !== '' && !body.trimStart().startsWith('<')) {
		return body.trim();
	}
	return `The OpenRouter API returned status ${statusCode}`;
}

async function apiRequest(
	context: IExecuteFunctions | ILoadOptionsFunctions,
	options: { method: IHttpRequestMethods; path: string; body?: IDataObject; timeout?: number },
	itemIndex?: number,
): Promise<unknown> {
	const credentials = await context.getCredentials(CREDENTIAL_NAME);
	const response = await context.helpers.httpRequestWithAuthentication.call(
		context,
		CREDENTIAL_NAME,
		{
			method: options.method,
			url: `${resolveBaseUrl(credentials.url)}${options.path}`,
			body: options.body,
			timeout: options.timeout,
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			// Keep the API key on OpenRouter's host if a response redirects elsewhere
			sendCredentialsOnCrossOriginRedirect: false,
		},
	);
	const { statusCode, body } = response as { statusCode: number; body: unknown };
	if (statusCode >= 300) {
		throw new NodeApiError(context.getNode(), (body ?? {}) as JsonObject, {
			message: describeApiError(body, statusCode),
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	return body;
}

interface NormalizedQuestion {
	type: QuestionType;
	instructions: string;
	/** Choice option names, or score level descriptions, lowest first */
	options: string[];
	/** Choice option descriptions, or the noul meanings of true and false */
	meanings: Record<string, string>;
}

function normalizeQuestion(id: string, raw: unknown): NormalizedQuestion {
	const question = (raw ?? {}) as { type?: unknown; instructions?: unknown; criteria?: unknown };
	const type = question.type ?? 'noul';
	if (type !== 'choice' && type !== 'noul' && type !== 'score') {
		throw new Error(`Question "${id}": unknown type "${String(type)}"`);
	}
	const instructions = typeof question.instructions === 'string' ? question.instructions : '';
	const criteria = question.criteria;
	const meanings: Record<string, string> = {};
	let options: string[] = [];
	if (Array.isArray(criteria)) {
		options = criteria.map(String);
	} else if (typeof criteria === 'object' && criteria !== null) {
		for (const [key, value] of Object.entries(criteria)) {
			if (typeof value === 'string' && value.trim() !== '') meanings[key] = value;
		}
		options = type === 'score' ? Object.values(criteria).map(String) : Object.keys(criteria);
	}
	if (type !== 'noul' && options.length < 2) {
		throw new Error(`Question "${id}": a ${type} question needs at least 2 criteria`);
	}
	return { type, instructions, options, meanings };
}

function normalizeQuestions(questions: unknown): Record<string, NormalizedQuestion> {
	if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
		throw new Error('The questions must be a JSON object keyed by question ID');
	}
	return Object.fromEntries(
		Object.entries(questions).map(([id, question]) => [id, normalizeQuestion(id, question)]),
	);
}

const PROBABILITY_SCHEMA = {
	type: 'number',
	description: 'A calibrated probability from 0 to 1',
};

/** The strict JSON schema of the answers, with one property per question ID */
export function buildAnswerSchema(questions: unknown): IDataObject {
	const normalized = normalizeQuestions(questions);
	const properties: IDataObject = {};
	for (const [id, question] of Object.entries(normalized)) {
		if (question.type === 'choice') {
			properties[id] = {
				type: 'object',
				properties: {
					choice: { type: 'string', enum: question.options },
					confidence: {
						...PROBABILITY_SCHEMA,
						description: 'Probability that the choice is right, from 0 to 1',
					},
				},
				required: ['choice', 'confidence'],
				additionalProperties: false,
			};
		} else if (question.type === 'score') {
			properties[id] = {
				type: 'object',
				properties: {
					score: { type: 'integer', enum: question.options.map((_, index) => index) },
					confidence: {
						...PROBABILITY_SCHEMA,
						description: 'Probability that the score is right, from 0 to 1',
					},
				},
				required: ['score', 'confidence'],
				additionalProperties: false,
			};
		} else {
			properties[id] = {
				type: 'object',
				properties: {
					noul: {
						...PROBABILITY_SCHEMA,
						description: 'Probability that the answer is true, from 0 to 1',
					},
				},
				required: ['noul'],
				additionalProperties: false,
			};
		}
	}
	return {
		type: 'object',
		properties,
		required: Object.keys(properties),
		additionalProperties: false,
	};
}

const SYSTEM_PROMPT = [
	'You evaluate a state, which is the content given by the user, and answer typed questions about it.',
	'Answer every question with a JSON object under its ID, following the JSON schema exactly.',
	'A choice question: "choice" is the one option that fits best, and "confidence" the probability it is right.',
	'A score question: "score" is the index of the level that fits best, 0 being the lowest, and "confidence" the probability it is right.',
	'A noul question: "noul" is the probability, from 0 to 1, that the answer is true.',
	'Give calibrated probabilities. Reply with JSON only.',
].join('\n');

function describeQuestion(question: NormalizedQuestion): IDataObject {
	const described: IDataObject = { type: question.type, instructions: question.instructions };
	if (question.type === 'choice') {
		described.options = Object.fromEntries(
			question.options.map((option) => [option, question.meanings[option] ?? null]),
		);
	} else if (question.type === 'score') {
		described.levels = Object.fromEntries(question.options.map((level, index) => [index, level]));
	} else if (Object.keys(question.meanings).length > 0) {
		described.meanings = question.meanings;
	}
	return described;
}

/** The chat completion request that asks the questions about the state */
export function buildChatRequest(body: IDataObject): IDataObject {
	const questions = normalizeQuestions(body.questions);
	const state = typeof body.state === 'string' ? body.state : JSON.stringify(body.state, null, 2);
	const described = Object.fromEntries(
		Object.entries(questions).map(([id, question]) => [id, describeQuestion(question)]),
	);
	return {
		model: body.model,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{
				role: 'user',
				content: `State:\n${state}\n\nQuestions:\n${JSON.stringify(described, null, 2)}`,
			},
		],
		response_format: {
			type: 'json_schema',
			json_schema: { name: 'answers', strict: true, schema: buildAnswerSchema(body.questions) },
		},
		temperature: 0,
	};
}

function toProbability(value: unknown): number | undefined {
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
	return Math.min(Math.max(value, 0), 1);
}

function stripCodeFence(text: string): string {
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
	return match ? match[1] : text;
}

function parseJsonOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/** Maps the model's JSON reply onto typed answers. Throws when the reply does not fit. */
export function parseAnswers(questions: unknown, content: unknown): Record<string, Answer> {
	const normalized = normalizeQuestions(questions);
	if (typeof content !== 'string' || content.trim() === '') {
		throw new Error('The model returned no answer');
	}
	const parsed = parseJsonOrUndefined(stripCodeFence(content));
	if (parsed === undefined) {
		throw new Error(
			'The model did not return valid JSON. Choose a model that supports structured outputs.',
		);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('The model did not return a JSON object of answers');
	}
	const answers: Record<string, Answer> = {};
	for (const [id, question] of Object.entries(normalized)) {
		const raw = (parsed as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
		if (typeof raw !== 'object' || raw === null) {
			throw new Error(`The model returned no answer to question "${id}"`);
		}
		const confidence = toProbability(raw.confidence);
		if (question.type === 'choice') {
			const choice = raw.choice;
			if (typeof choice !== 'string' || !question.options.includes(choice)) {
				throw new Error(
					`The model answered question "${id}" with "${String(choice)}", which is not one of its options`,
				);
			}
			answers[id] =
				confidence === undefined
					? { type: 'choice', choice }
					: { type: 'choice', choice, confidence };
		} else if (question.type === 'score') {
			const score = typeof raw.score === 'string' ? Number(raw.score) : raw.score;
			if (typeof score !== 'number' || !Number.isFinite(score)) {
				throw new Error(`The model returned no score for question "${id}"`);
			}
			const answer: ScoreAnswer = {
				type: 'score',
				score: Math.min(Math.max(score, 0), question.options.length - 1),
				legend: Object.fromEntries(question.options.map((level, index) => [String(index), level])),
			};
			if (confidence !== undefined) answer.confidence = confidence;
			answers[id] = answer;
		} else {
			const noul = toProbability(raw.noul);
			if (noul === undefined) {
				throw new Error(`The model returned no probability for question "${id}"`);
			}
			answers[id] = { type: 'noul', noul };
		}
	}
	return answers;
}

interface ChatCompletion {
	model?: string;
	choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
	usage?: IDataObject;
}

export async function evaluateState(
	context: IExecuteFunctions,
	itemIndex: number,
	body: IDataObject,
	timeout: number,
): Promise<SystemOneResponse> {
	const fail = (message: string, response: unknown = {}): never => {
		throw new NodeApiError(context.getNode(), (response ?? {}) as JsonObject, {
			message,
			itemIndex,
		});
	};
	let request: IDataObject = {};
	try {
		request = buildChatRequest(body);
	} catch (error) {
		fail((error as Error).message);
	}
	const response = (await apiRequest(
		context,
		{ method: 'POST', path: '/v1/chat/completions', body: request, timeout },
		itemIndex,
	)) as ChatCompletion;
	let answers: Record<string, Answer> = {};
	try {
		answers = parseAnswers(body.questions, response?.choices?.[0]?.message?.content);
	} catch (error) {
		fail((error as Error).message, response);
	}
	return {
		model: response.model ?? String(body.model),
		answers,
		usage: response.usage,
	};
}

export async function searchModels(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const response = (await apiRequest(this, { method: 'GET', path: '/v1/models' })) as {
		data?: ModelCard[];
	};
	const needle = (filter ?? '').toLowerCase();
	const results = (response.data ?? [])
		.filter((model) => `${model.id} ${model.name ?? ''}`.toLowerCase().includes(needle))
		.map((model) => ({
			name: model.name ?? model.id,
			value: model.id,
			description: model.description,
		}));
	return { results };
}
