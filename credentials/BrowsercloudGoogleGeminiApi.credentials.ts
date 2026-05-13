import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class BrowsercloudGoogleGeminiApi implements ICredentialType {
	name = 'browsercloudGoogleGeminiApi';
	displayName = 'Google Gemini API (Browsercloud)';
	documentationUrl = 'https://aistudio.google.com/apikey';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your Google Gemini API key (starts with AIza). Picked up by Browsercloud script-runner as both process.env.GEMINI_API_KEY and process.env.GOOGLE_API_KEY for scripts that call Gemini.',
		},
	];
}
