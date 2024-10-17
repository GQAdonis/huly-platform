import { Timestamp } from "@hcengineering/core"

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
    name: string
    members?: ImportPerson[] // todo: person vs account

    docs: T[]
}
export interface ImportDoc<T extends ImportDoc<T>> {
    title: string
    descrProvider: () => Promise<string>

    subdocs: T[]
}

export interface ImportTeamspace extends ImportSpace<ImportDocument> {
}

export interface ImportDocument extends ImportDoc<ImportDocument> {
}

export interface ImportProject extends ImportSpace<ImportIssue> {
    identifier: string
    private: boolean
    autoJoin: boolean
    defaultAssignee?: ImportPerson
    defaultIssueStatus?: ImportStatus
    owners?: ImportPerson[]
    members?: ImportPerson[]
}

export interface ImportIssue extends ImportDoc<ImportIssue> {
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
    public async updateWorkspace(workspaceData: ImportWorkspace) {

    }
}
