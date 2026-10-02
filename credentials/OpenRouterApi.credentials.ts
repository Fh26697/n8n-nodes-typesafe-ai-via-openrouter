import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

import { BASE_URL_EXPRESSION, DEFAULT_BASE_URL } from '../nodes/TypeSafeAi/api';

export class OpenRouterApi implements ICredentialType {
	name = 'openRouterApi';

	displayName = 'OpenRouter API';

	documentationUrl = 'https://openrouter.ai/docs';

	icon: Icon = {
		light: 'file:../nodes/TypeSafeAi/typeSafeAi.svg',
		dark: 'file:../nodes/TypeSafeAi/typeSafeAi.dark.svg',
	};

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Create one at openrouter.ai/keys',
		},
		{
			displayName: 'Base URL',
			name: 'url',
			type: 'hidden',
			default: DEFAULT_BASE_URL,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: BASE_URL_EXPRESSION,
			url: '/v1/models',
			method: 'GET',
		},
	};
}
