import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class BrowsercloudOpenAiApi implements ICredentialType {
	name = 'browsercloudOpenAiApi';
	displayName = 'OpenAI API (Browsercloud)';
	documentationUrl = 'https://platform.openai.com/api-keys';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your OpenAI API key (starts with sk-). Picked up by Browsercloud script-runner as process.env.OPENAI_API_KEY for scripts that call OpenAI.',
		},
	];
}
