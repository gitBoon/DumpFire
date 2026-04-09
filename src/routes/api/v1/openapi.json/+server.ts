import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const spec = {
	openapi: '3.1.0',
	info: {
		title: 'DumpFire API',
		version: '1.0.0',
		description:
			'REST API for the DumpFire Kanban board. Automate card creation, movement, assignments, and more.',
		contact: { name: 'DumpFire' }
	},
	servers: [{ url: '/', description: 'Current instance' }],
	security: [{ bearerAuth: [] }],
	components: {
		securitySchemes: {
			bearerAuth: {
				type: 'http',
				scheme: 'bearer',
				description:
					'API key prefixed with `df_`. Generate one from My Account → API Keys.'
			}
		},
		schemas: {
			Error: {
				type: 'object',
				properties: {
					error: { type: 'string', description: 'Human-readable error message' }
				},
				required: ['error']
			},
			User: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					username: { type: 'string' },
					email: { type: 'string', format: 'email' },
					emoji: { type: 'string' },
					role: { type: 'string', enum: ['user', 'admin', 'superadmin'] }
				}
			},
			Board: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					emoji: { type: 'string' },
					parentCardId: { type: ['integer', 'null'] },
					categoryId: { type: ['integer', 'null'] },
					isPublic: { type: 'boolean' },
					createdBy: { type: 'integer' },
					createdAt: { type: 'string' },
					updatedAt: { type: 'string' }
				}
			},
			Column: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					title: { type: 'string' },
					position: { type: 'integer' },
					color: { type: 'string', description: 'Hex colour code' }
				}
			},
			BoardDetail: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					name: { type: 'string' },
					emoji: { type: 'string' },
					columns: { type: 'array', items: { $ref: '#/components/schemas/Column' } }
				}
			},
			Card: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					columnId: { type: 'integer' },
					title: { type: 'string' },
					description: { type: 'string' },
					priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
					position: { type: 'integer' },
					dueDate: { type: ['string', 'null'] },
					columnTitle: { type: 'string' },
					createdAt: { type: 'string' },
					updatedAt: { type: 'string' }
				}
			},
			Assignee: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					username: { type: 'string' },
					emoji: { type: 'string' }
				}
			},
			Subtask: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					cardId: { type: 'integer' },
					title: { type: 'string' },
					description: { type: 'string' },
					priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
					completed: { type: 'boolean' },
					position: { type: 'integer' }
				}
			},
			CardDetail: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					columnId: { type: 'integer' },
					boardId: { type: 'integer' },
					columnTitle: { type: 'string' },
					title: { type: 'string' },
					description: { type: 'string' },
					priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
					subtasks: { type: 'array', items: { $ref: '#/components/schemas/Subtask' } },
					labelIds: { type: 'array', items: { type: 'integer' } },
					assignees: { type: 'array', items: { $ref: '#/components/schemas/Assignee' } }
				}
			},
			Comment: {
				type: 'object',
				properties: {
					id: { type: 'integer' },
					cardId: { type: 'integer' },
					userId: { type: 'integer' },
					content: { type: 'string' },
					createdAt: { type: 'string' },
					updatedAt: { type: 'string' },
					username: { type: 'string' },
					userEmoji: { type: 'string' }
				}
			}
		},
		parameters: {
			boardId: {
				name: 'boardId',
				in: 'path',
				required: true,
				schema: { type: 'integer' },
				description: 'Board ID'
			},
			cardId: {
				name: 'cardId',
				in: 'path',
				required: true,
				schema: { type: 'integer' },
				description: 'Card ID'
			},
			subtaskId: {
				name: 'subtaskId',
				in: 'path',
				required: true,
				schema: { type: 'integer' },
				description: 'Subtask ID'
			}
		},
		responses: {
			Unauthorized: {
				description: 'Missing or invalid API key',
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/Error' },
						example: { error: 'Invalid or expired API key' }
					}
				}
			},
			NotFound: {
				description: 'Resource not found',
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/Error' },
						example: { error: 'Not found' }
					}
				}
			},
			RateLimited: {
				description: 'Rate limit exceeded (60 req/min)',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								error: { type: 'string' },
								retryAfterSecs: { type: 'integer' }
							}
						},
						example: { error: 'Rate limit exceeded', retryAfterSecs: 42 }
					}
				}
			}
		}
	},
	paths: {
		'/api/v1/me': {
			get: {
				tags: ['User'],
				summary: 'Get current user',
				description: 'Returns the profile of the user associated with the API key.',
				operationId: 'getCurrentUser',
				responses: {
					'200': {
						description: 'User profile',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/User' },
								example: {
									id: 2,
									username: 'Greg Boon',
									email: 'greg@example.com',
									emoji: '🧑‍💻',
									role: 'admin'
								}
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' }
				}
			}
		},

		'/api/v1/boards': {
			get: {
				tags: ['Boards'],
				summary: 'List boards',
				description: "Returns all boards the API key's user has access to.",
				operationId: 'listBoards',
				responses: {
					'200': {
						description: 'List of boards',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Board' } }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' }
				}
			},
			post: {
				tags: ['Boards'],
				summary: 'Create a board',
				description: 'Creates a new board with default columns (To Do, On Hold, In Progress, Complete). The API key\'s user is automatically added as board owner. To create a sub-board linked to a card, pass parentCardId.',
				operationId: 'createBoard',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: {
									name: { type: 'string', maxLength: 200, description: 'Board name' },
									emoji: { type: 'string', description: 'Board emoji icon (default: 📋)' },
									parentCardId: { type: 'integer', nullable: true, description: 'ID of a card to link this board to as a sub-board' }
								}
							},
							examples: {
								basic: {
									summary: 'Create a standalone board',
									value: { name: 'Sprint 43', emoji: '🚀' }
								},
								subBoard: {
									summary: 'Create a sub-board linked to a card',
									value: { name: 'Sub-project Tasks', emoji: '📂', parentCardId: 10 }
								}
							}
						}
					}
				},
				responses: {
					'201': {
						description: 'Board created with default columns',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/BoardDetail' }
							}
						}
					},
					'400': { description: 'Invalid input (missing name or name too long)' },
					'401': { $ref: '#/components/responses/Unauthorized' },
					'403': { description: 'No edit access to parent card\'s board (sub-board only)' },
					'404': { description: 'Parent card not found (sub-board only)' }
				}
			}
		},

		'/api/v1/boards/{boardId}': {
			get: {
				tags: ['Boards'],
				summary: 'Get board details',
				description: 'Returns a single board with its columns.',
				operationId: 'getBoard',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				responses: {
					'200': {
						description: 'Board with columns',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/BoardDetail' }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'404': { $ref: '#/components/responses/NotFound' }
				}
			}
		},

		'/api/v1/boards/{boardId}/cards': {
			get: {
				tags: ['Cards'],
				summary: 'List cards on a board',
				operationId: 'listCards',
				parameters: [
					{ $ref: '#/components/parameters/boardId' },
					{
						name: 'columnId',
						in: 'query',
						schema: { type: 'integer' },
						description: 'Filter cards to a specific column'
					},
					{
						name: 'archived',
						in: 'query',
						schema: { type: 'boolean', default: false },
						description: 'Include archived cards'
					}
				],
				responses: {
					'200': {
						description: 'List of cards',
						content: {
							'application/json': {
								schema: { type: 'array', items: { $ref: '#/components/schemas/Card' } }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' }
				}
			},
			post: {
				tags: ['Cards'],
				summary: 'Create a card',
				operationId: 'createCard',
				parameters: [{ $ref: '#/components/parameters/boardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['columnId', 'title'],
								properties: {
									columnId: { type: 'integer', description: 'Target column ID' },
									title: { type: 'string', maxLength: 500 },
									description: { type: 'string', maxLength: 50000 },
									priority: {
										type: 'string',
										enum: ['low', 'medium', 'high', 'critical'],
										default: 'medium'
									},
									colorTag: { type: 'string', description: 'Hex colour for visual tagging' },
									categoryId: { type: 'integer' },
									dueDate: { type: 'string', format: 'date', description: 'ISO date' },
									businessValue: { type: 'string' },
									position: { type: 'integer', default: 0 }
								}
							},
							example: {
								columnId: 1,
								title: 'Deploy v2.1',
								description: 'Run migrations, update configs',
								priority: 'high',
								dueDate: '2026-04-20'
							}
						}
					}
				},
				responses: {
					'201': {
						description: 'Card created',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Card' } }
						}
					},
					'400': {
						description: 'Validation error',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' }
				}
			}
		},

		'/api/v1/cards/{cardId}': {
			get: {
				tags: ['Cards'],
				summary: 'Get a single card',
				description: 'Returns the card with its subtasks, label IDs, and assignees.',
				operationId: 'getCard',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'Card details',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/CardDetail' }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'404': { $ref: '#/components/responses/NotFound' }
				}
			},
			put: {
				tags: ['Cards'],
				summary: 'Update a card',
				operationId: 'updateCard',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									title: { type: 'string' },
									description: { type: 'string' },
									priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
									colorTag: { type: 'string' },
									categoryId: { type: 'integer' },
									dueDate: { type: 'string' },
									onHoldNote: { type: 'string' },
									businessValue: { type: 'string' },
									pinned: { type: 'boolean' },
									coverUrl: { type: 'string' },
									archivedAt: { type: 'string', nullable: true, description: 'Set to null to restore an archived card' }
								}
							},
							examples: {
								update: {
									summary: 'Update priority and due date',
									value: { priority: 'critical', dueDate: '2026-04-12' }
								},
								restore: {
									summary: 'Restore an archived card',
									value: { archivedAt: null }
								}
							}
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated card',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Card' } }
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'404': { $ref: '#/components/responses/NotFound' }
				}
			},
			delete: {
				tags: ['Cards'],
				summary: 'Delete a card',
				description:
					'Archives the card by default (soft-delete). Add `?permanent=true` to permanently delete.',
				operationId: 'deleteCard',
				parameters: [
					{ $ref: '#/components/parameters/cardId' },
					{
						name: 'permanent',
						in: 'query',
						schema: { type: 'boolean', default: false },
						description: 'Permanently delete instead of archiving'
					}
				],
				responses: {
					'200': {
						description: 'Deleted',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: { success: { type: 'boolean' } }
								},
								example: { success: true }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'404': { $ref: '#/components/responses/NotFound' }
				}
			}
		},

		'/api/v1/cards/{cardId}/assignees': {
			get: {
				tags: ['Assignees'],
				summary: 'List assignees',
				operationId: 'listAssignees',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'Assignee list',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/Assignee' }
								}
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' }
				}
			},
			post: {
				tags: ['Assignees'],
				summary: 'Assign a user',
				operationId: 'assignUser',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['userId'],
								properties: { userId: { type: 'integer' } }
							}
						}
					}
				},
				responses: {
					'200': {
						description: 'User assigned',
						content: {
							'application/json': {
								example: { success: true, message: 'User assigned' }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' }
				}
			},
			delete: {
				tags: ['Assignees'],
				summary: 'Remove an assignee',
				operationId: 'removeAssignee',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['userId'],
								properties: { userId: { type: 'integer' } }
							}
						}
					}
				},
				responses: {
					'200': {
						description: 'Assignee removed',
						content: {
							'application/json': { example: { success: true } }
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' }
				}
			}
		},

		'/api/v1/cards/{cardId}/move': {
			put: {
				tags: ['Cards'],
				summary: 'Move a card',
				description:
					'Moves a card between columns. Moving to "Complete" awards XP and fires a celebration event.',
				operationId: 'moveCard',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['columnId'],
								properties: {
									columnId: { type: 'integer', description: 'Target column ID' },
									position: { type: 'integer', description: 'Position within column' }
								}
							},
							example: { columnId: 4, position: 0 }
						}
					}
				},
				responses: {
					'200': {
						description: 'Card moved',
						content: {
							'application/json': {
								example: {
									id: 10,
									columnId: 4,
									columnTitle: 'Complete',
									boardId: 1,
									completedAt: '2026-04-09T10:45:00.000Z'
								}
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'404': { $ref: '#/components/responses/NotFound' }
				}
			}
		},

		'/api/v1/cards/{cardId}/subtasks': {
			get: {
				tags: ['Subtasks'],
				summary: 'List subtasks',
				operationId: 'listSubtasks',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'Subtask list',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/Subtask' }
								}
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' }
				}
			},
			post: {
				tags: ['Subtasks'],
				summary: 'Create a subtask',
				operationId: 'createSubtask',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['title'],
								properties: {
									title: { type: 'string', maxLength: 500 },
									description: { type: 'string' },
									priority: {
										type: 'string',
										enum: ['low', 'medium', 'high', 'critical']
									},
									colorTag: { type: 'string' },
									dueDate: { type: 'string', format: 'date' },
									position: { type: 'integer' }
								}
							}
						}
					}
				},
				responses: {
					'201': {
						description: 'Subtask created',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Subtask' }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' }
				}
			}
		},

		'/api/v1/subtasks/{subtaskId}': {
			put: {
				tags: ['Subtasks'],
				summary: 'Update a subtask',
				operationId: 'updateSubtask',
				parameters: [{ $ref: '#/components/parameters/subtaskId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									title: { type: 'string' },
									description: { type: 'string' },
									priority: {
										type: 'string',
										enum: ['low', 'medium', 'high', 'critical']
									},
									colorTag: { type: 'string' },
									dueDate: { type: 'string' },
									completed: { type: 'boolean' },
									position: { type: 'integer' }
								}
							},
							example: { completed: true }
						}
					}
				},
				responses: {
					'200': {
						description: 'Updated subtask',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Subtask' }
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'404': { $ref: '#/components/responses/NotFound' }
				}
			},
			delete: {
				tags: ['Subtasks'],
				summary: 'Delete a subtask',
				description: 'Permanently deletes the subtask.',
				operationId: 'deleteSubtask',
				parameters: [{ $ref: '#/components/parameters/subtaskId' }],
				responses: {
					'200': {
						description: 'Deleted',
						content: {
							'application/json': { example: { success: true } }
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'404': { $ref: '#/components/responses/NotFound' }
				}
			}
		},

		'/api/v1/cards/{cardId}/comments': {
			get: {
				tags: ['Comments'],
				summary: 'List comments',
				description: 'Returns all comments on a card, newest first.',
				operationId: 'listComments',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				responses: {
					'200': {
						description: 'Comment list',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: { $ref: '#/components/schemas/Comment' }
								}
							}
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'404': { $ref: '#/components/responses/NotFound' }
				}
			},
			post: {
				tags: ['Comments'],
				summary: 'Add a comment',
				description: 'Posts a comment on a card. Notifies board members via email.',
				operationId: 'createComment',
				parameters: [{ $ref: '#/components/parameters/cardId' }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['content'],
								properties: {
									content: { type: 'string', description: 'Comment text (markdown supported)' }
								}
							},
							example: { content: 'Investigated the issue — root cause was a missing null check in the auth middleware.' }
						}
					}
				},
				responses: {
					'201': {
						description: 'Comment created',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/Comment' }
							}
						}
					},
					'400': {
						description: 'Comment cannot be empty',
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/Error' } }
						}
					},
					'401': { $ref: '#/components/responses/Unauthorized' },
					'404': { $ref: '#/components/responses/NotFound' }
				}
			}
		}
	},
	tags: [
		{ name: 'User', description: 'Current authenticated user' },
		{ name: 'Boards', description: 'Kanban boards' },
		{ name: 'Cards', description: 'Task cards on boards' },
		{ name: 'Assignees', description: 'Card user assignments' },
		{ name: 'Subtasks', description: 'Card subtasks / checklist items' },
		{ name: 'Comments', description: 'Card discussion comments' }
	]
};

/** GET /api/v1/openapi.json — Public OpenAPI 3.1 specification. */
export const GET: RequestHandler = async () => {
	return json(spec, {
		headers: {
			'Cache-Control': 'public, max-age=10',
			'Access-Control-Allow-Origin': '*'
		}
	});
};
