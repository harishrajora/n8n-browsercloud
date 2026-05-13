import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class BrowsercloudAnthropicApi implements ICredentialType {
	name = 'browsercloudAnthropicApi';
	displayName = 'Anthropic API (Browsercloud)';
	documentationUrl = 'https://console.anthropic.com/settings/keys';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your Anthropic API key (starts with sk-ant-). Picked up by Browsercloud script-runner as process.env.ANTHROPIC_API_KEY for scripts that call Claude.',
		},
	];
}
