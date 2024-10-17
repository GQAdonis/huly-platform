import core, { collaborativeDocParse, Data, Doc, generateId, makeCollaborativeDoc, Ref, Timestamp, TxOperations } from "@hcengineering/core"
import { FileUploader } from "../fileUploader"
import task, { createProjectType, makeRank, Project, TaskTypeWithFactory, type ProjectType, type Task, type TaskType } from '@hcengineering/task'
import document, { type Document, type Teamspace, getFirstRank } from '@hcengineering/document'
import tracker from '@hcengineering/tracker'
import { title } from "process"
import { jsonToYDocNoSchema, parseMessageMarkdown } from "@hcengineering/text"
import { yDocToBuffer } from "@hcengineering/collaboration"

export interface ImportWorkspace {
    persons?: ImportPerson[]
    projectTypes?: ImportProjectType[]
    spaces?: ImportSpace<ImportDoc>[]
}

export interface ImportPerson {
    name: string
    email: string
}

export interface ImportProjectType {
    name: string
    taskTypes?: ImportTaskType[]
    description?: string
}

export interface ImportTaskType {
    name: string
    statuses: ImportStatus[]
    description?: string
}

export interface ImportStatus {
    name: string
    description?: string
}

export interface ImportSpace<T extends ImportDoc> {
    class: string
    name: string
    // members?: ImportPerson[] // todo: person vs account

    docs: T[]
}
export interface ImportDoc {
    class: string
    title: string
    descrProvider: () => Promise<string>

    subdocs: ImportDoc[]
}

export interface ImportTeamspace extends ImportSpace<ImportDocument> {
    class: 'document.class.TeamSpace'
}

export interface ImportDocument extends ImportDoc {
    class: 'document.class.Document'
    subdocs: ImportDocument[]
}

export interface ImportProject extends ImportSpace<ImportIssue> {
    class: 'tracker.class.Project'
    identifier: string
    private: boolean
    autoJoin: boolean
    defaultAssignee?: ImportPerson
    defaultIssueStatus?: ImportStatus
    owners?: ImportPerson[]
    members?: ImportPerson[]
    projectType?: ImportProjectType
}

export interface ImportIssue extends ImportDoc {
    class: 'tracker.class.Issue'
    status: ImportStatus
    assignee?: ImportPerson
    estimation?: number
    remainingTime?: number
    comments?: ImportComment[]
    collaborators?: ImportPerson[]
}
  
export interface ImportComment {
    text: string
    author?: ImportPerson // todo: person vs account
    date?: Timestamp
    attachments?: ImportAttachment[]
}

export interface ImportAttachment {
    title: string
    blobProvider: () => Promise<Blob>
}

export class WorkspaceImporter {
    constructor (
        private readonly client: TxOperations,
        private readonly fileUploader: FileUploader
    ) {}

    public async updateWorkspace(workspaceData: ImportWorkspace) {
        if (workspaceData.projectTypes !== undefined) {
            for (const projectType: ImportProject of workspaceData.projectTypes) {
                console.log("Import ProjectType: ", projectType.name)
                await this.importProjectType(projectType) // todo: create or update
                console.log("Import success: ", projectType.name)
            }
        }

        if (workspaceData.spaces !== undefined) {
            for (const space of workspaceData.spaces) {
                if (space.class === 'document.class.TeamSpace') {
                    await this.importTeamspace(space as ImportTeamspace)
                } else if (space.class === 'tracker.class.Project') {
                    await this.importProject(space as ImportProject)
                }
            }
        }
    }

    async importProjectType(projectType: ImportProjectType): Promise<Ref<ProjectType>> {
        const taskTypes: TaskTypeWithFactory[] = []
        if (projectType.taskTypes !== undefined) {
            for (const taskType: ImportTaskType of projectType.taskTypes) {
                const taskTypeId = generateId<TaskType>()
                const statuses = taskType.statuses.map((status) => {
                    return {
                      name: status.name,
                      ofAttribute: tracker.attribute.IssueStatus,
                      category: task.statusCategory.UnStarted
                    }
                  })
                taskTypes.push({
                    _id: taskTypeId,
                    descriptor: tracker.descriptors.Issue,
                    kind: 'both',
                    name: taskType.name,
                    ofClass: tracker.class.Issue,
                    statusCategories: [task.statusCategory.UnStarted],
                    statusClass: tracker.class.IssueStatus,
                    icon: tracker.icon.Issue,
                    color: 0,
                    allowedAsChildOf: [taskTypeId],
                    factory: statuses
                })
            }
        }
        const projectData = {
            name: projectType.name,
            descriptor: tracker.descriptors.ProjectType,
            shortDescription: projectType.description,
            description: '', // put the description as shortDescription, so the users can see it
            tasks: [],
            roles: 0,
            classic: true
        }
        return createProjectType(this.client, projectData, taskTypes, generateId())
    }

    async importTeamspace(space: ImportTeamspace): Promise<Ref<Teamspace>> {
        const teamspaceId = await this.createTeamspace(space)
        for (const doc of space.docs) {
            await this.createDocumentsWithSubdocs(doc, document.ids.NoParent, teamspaceId)
        }
        return teamspaceId
    }

    async createDocumentsWithSubdocs(doc: ImportDocument, parentId: Ref<Document>, teamspaceId: Ref<Teamspace> ): Promise<Ref<Document>> {
        const documentId = await this.createDocument(doc, parentId, teamspaceId)
        for (const child of doc.subdocs) {
            await this.createDocumentsWithSubdocs(child, documentId, teamspaceId)
        }
        return documentId
    }

    async createTeamspace(space: ImportTeamspace): Promise<Ref<Teamspace>> {
        const teamspaceId = generateId<Teamspace>()
        const data = {
          type: document.spaceType.DefaultTeamspaceType,
          description: 'Imported from Notion',
          title: space.name,
          name: space.name,
          private: false,
          members: [],
          owners: [],
          autoJoin: false,
          archived: false
        }
        await this.client.createDoc(document.class.Teamspace, core.space.Space, data, teamspaceId)
        return teamspaceId
    }

    async createDocument (
        doc: ImportDocument,
        parentId: Ref<Document>,
        teamspaceId: Ref<Teamspace>
    ): Promise<Ref<Document>> {
        const md = await doc.descrProvider()
        const json = parseMessageMarkdown(md, 'image://')
      
        const id = generateId<Document>()
        const collabId = makeCollaborativeDoc(id, 'description')
        const yDoc = jsonToYDocNoSchema(json, 'content')
        const { documentId } = collaborativeDocParse(collabId)
        const buffer = yDocToBuffer(yDoc)
      
        const form = new FormData()
        const file = new File([new Blob([buffer])], doc.title)
        form.append('file', file, documentId)
        form.append('type', 'application/ydoc')
        form.append('size', buffer.length.toString())
        form.append('name', doc.title)
        form.append('id', id)
        form.append('data', new Blob([buffer])) // ?
        await this.fileUploader(id, form)
      
        const lastRank = await getFirstRank(this.client, teamspaceId, parentId)
        const rank = makeRank(lastRank, undefined)
      
        const attachedData: Data<Document> = {
          title: doc.title,
          description: collabId,
          parent: parentId,
          attachments: 0,
          embeddings: 0,
          labels: 0,
          comments: 0,
          references: 0,
          rank
        }
      
        await this.client.createDoc(document.class.Document, teamspaceId, attachedData, id)
        return id
    }

    async importProject(project: ImportProject): Promise<Ref<Project>> {
        
    }

}
