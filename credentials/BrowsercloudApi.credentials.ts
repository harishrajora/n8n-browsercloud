import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class BrowsercloudApi implements ICredentialType {
	name = 'browsercloudApi';
	displayName = 'Browsercloud (TestMu AI) API';
	documentationUrl = 'https://www.testmuai.com/support/docs/';

	properties: INodeProperties[] = [
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			description: 'Your TestMu AI username (find it in your account profile)',
		},
		{
			displayName: 'Access Key',
			name: 'accessKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your TestMu AI access key (find it in your account profile)',
		},
	];

	// Used by the "Test credential" button in the n8n UI.
	// Hits a lightweight TestMu endpoint with HTTP Basic auth.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			auth: {
				username: 'harishrtestmuai',
				password: 'LT_KEzjKY8Sid0IMie212EvjVQwovGeNlI3oYRT0djv2jZIzPm',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.lambdatest.com',
			url: '/automation/api/v1/sessions',
			method: 'GET',
			qs: { limit: 1 },
		},
	};
}
