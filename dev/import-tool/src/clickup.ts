import core, {
  type Class,
  collaborativeDocParse,
  type Data,
  type DocumentQuery,
  generateId,
  makeCollaborativeDoc,
  type Ref,
  type Status,
  type Timestamp,
  type TxOperations
} from '@hcengineering/core'
import { download, type FileUploader } from './fileUploader'
import document, { getFirstRank, type Document, type Teamspace } from '@hcengineering/document'
import tracker from '@hcengineering/tracker'
import pluginState, {
  type Issue,
  IssuePriority,
  type IssueStatus,
  type Project,
  TimeReportDayType
} from '@hcengineering/tracker'
import { jsonToYDocNoSchema, parseMessageMarkdown } from '@hcengineering/text'
import { yDocToBuffer } from '@hcengineering/collaboration'
import { readdir, readFile } from 'fs/promises'
import { join, parse } from 'path'
import csv from 'csvtojson'
import task, { createProjectType, makeRank, type ProjectType, type Task, type TaskType } from '@hcengineering/task'
import { importComment, type ImportComment, importIssue, type ImportIssue } from './importer/importer'
import attachment from '@hcengineering/model-attachment'
import { blob } from 'stream/consumers'

interface ClickupTask {
  'Task ID': string
  'Task Name': string
  'Task Content': string
  Status: string
  'Parent ID': string
  Attachments: string
  Assignees: string
  Priority?: number
  'Space Name': string
  Checklists: string // todo: obj
  Comments: string // todo: obj[]
  'Time Estimated': number
  'Time Spent': number
}

interface ClickupComment {
  by: string
  date: Timestamp
  text: string
}

interface ClickupAttachment {
  title: string
  url: string
}

const CLICKUP_PROJECT_TYPE_ID = generateId<ProjectType>()
const CLICKUP_TASK_TYPE_ID = generateId<TaskType>()
const CLICKUP_MIXIN_ID = `${CLICKUP_TASK_TYPE_ID}:type:mixin` as Ref<Class<Task>>

export async function importClickUp (
  client: TxOperations,
  uploadFile: FileUploader,
  dir: string,
  teamspace: Ref<Teamspace>
): Promise<void> {
  const files = await readdir(dir, { recursive: true })
  console.log(files)

  for (const file of files) {
    const parsedFileName = parse(file)
    const extension = parsedFileName.ext.toLowerCase()
    const fullPath = join(dir, file)
    if (extension === '.md') {
      await processClickupDocument(fullPath, client, uploadFile, parsedFileName.name, teamspace)
    } else if (extension === '.csv') {
      await processClickupTasks(fullPath, client, uploadFile)
    }
  }
}

async function processClickupDocument (
  fullPath: string,
  client: TxOperations,
  uploadFile: (id: string, data: any) => Promise<any>,
  docName: string,
  teamspace: string & {
    __ref: Teamspace
  }
): Promise<void> {
  const data = await readFile(fullPath)
  await importPageDocument(client, uploadFile, docName, data, teamspace)
}

async function traverseCsv (file: string, callback: (json: ClickupTask) => Promise<void> | void): Promise<void> {
  const jsonArray = await csv().fromFile(file)
  for (const json of jsonArray) {
    const clickupTask = json as ClickupTask
    await callback(clickupTask)
  }
}

async function processClickupTasks (
  file: string,
  client: TxOperations,
  uploadFile: (id: string, data: any) => Promise<any>
): Promise<void> {
  const clickupHulyIdMap = new Map<string, Ref<Issue>>()
  const statuses = new Set<string>()
  const projects = new Set<string>()
  const persons = new Set<string>()
  const emails = new Set<string>()

  await traverseCsv(file, (clickupTask) => {
    clickupHulyIdMap.set(clickupTask['Task ID'], generateId())
    statuses.add(clickupTask.Status)
    projects.add(clickupTask['Space Name'])

    clickupTask.Assignees.substring(1, clickupTask.Assignees.length - 1)
      .split(',')
      .filter((name) => name.length > 0)
      .forEach((name) => persons.add(name))

    JSON.parse(clickupTask.Comments).forEach((comment: ClickupComment) => {
      emails.add(comment.by)
    })
  })

  // console.log(clickupHulyIdMap)
  // console.log(statuses)
  // console.log(projects)
  // console.log(persons)
  // console.log(emails)

  const projectType = await createClickUpProjectType(client, Array.from(statuses))

  const projectIdMap = new Map<string, Ref<Project>>()
  for (const project of projects) {
    const hulyProjectId = await createProject(client, project, projectType)
    projectIdMap.set(project, hulyProjectId)
  }

  await traverseCsv(file, async (clickupTask) => {
    const hulyIssue = await convertToImportIssue(client, clickupTask)
    const hulyId = clickupHulyIdMap.get(clickupTask['Task ID'])
    const hulyProjectId = projectIdMap.get(clickupTask['Space Name'])
    if (hulyId === undefined || hulyProjectId === undefined) {
      throw new Error(`Issue not found: ${hulyId}, ${hulyProjectId}`)
    }
    await importIssue(client, uploadFile, hulyId, hulyIssue, hulyProjectId)
    console.log('IMPORTED: ', hulyIssue.title)
  })
}

async function convertToImportIssue (client: TxOperations, clickup: ClickupTask): Promise<ImportIssue> {
  const query: DocumentQuery<Status> = {
    name: clickup.Status,
    ofAttribute: pluginState.attribute.IssueStatus,
    category: task.statusCategory.UnStarted
  }

  const status = await client.findOne(tracker.class.IssueStatus, query)
  if (status === undefined) {
    throw new Error('Issue status not found: ' + clickup.Status)
  }

  const content = fixMultilineString(clickup['Task Content'])
  const checklists = convertChecklistsToMarkdown(clickup.Checklists)

  const estimation = clickup['Time Estimated']
  const remainingTime = estimation - clickup['Time Spent']

  const comments = convertToImportComments(clickup.Comments)
  const attachments = await convertAttachmentsToComment(clickup.Attachments)

  return {
    title: '[' + clickup['Task ID'] + '] ' + clickup['Task Name'],
    description: `${content}\n\n---\n${checklists}`, // todo: test all the combinations
    assignee: null, // todo
    status: status._id,
    priority: IssuePriority.NoPriority, // todo
    estimation,
    remainingTime,
    comments: comments.concat(attachments)
  }
}

function convertToImportComments (clickup: string): ImportComment[] {
  return JSON.parse(clickup).map((comment: ClickupComment) => {
    return {
      text: comment.text,
      date: new Date(comment.date).getTime()
    }
  })
}

type ClickupChecklist = Record<string, string[]>

async function convertAttachmentsToComment (clickup: string): Promise<ImportComment[]> {
  const res: ImportComment[] = []
  const attachments: ClickupAttachment[] = JSON.parse(clickup)
  for (const attachment of attachments) {
    const blob = await download(attachment.url) // todo: handle error (broken link, or no vpn)
    res.push({
      // text: `</br> Attachment: <a href='${attachment.url}'>${attachment.title}</a>`,
      text: `(${attachment.url})[${attachment.title}]`,
      attachments: [
        {
          title: attachment.title,
          blob
        }
      ]
    })
  }
  return res
}

// const form = new FormData()
// const file = new File([blob], attachment.title)
// form.append('file', file)
// form.append('type', file.type)
// form.append('size', file.size.toString())
// form.append('name', attachment.title)
// const id = generateId()
// form.append('id', id)
// form.append('data', blob) // ?

// async (): Promise<File | undefined> => {
//   const blob = await ops.blobProvider?.({ file: v.urlDownload, id: `${v.id}` })
//   if (blob !== undefined) {
//     return new File([blob], v.name)
//   }
// },
// (file: File, attach: Attachment) => {
//   attach.attachedTo = c._id  // куда положить??
//   attach.type = file.type
//   attach.size = file.size
//   attach.name = file.name
// }

// error handlong: ?
// const edData = await op()
// if (edData === undefined) {
//   console.error('Failed to retrieve document data', ed.name)
//   continue
// }

function convertChecklistsToMarkdown (clickup: string): string {
  const checklists = JSON.parse(clickup)
  let huly: string = '\n'
  for (const [key, values] of Object.entries(checklists)) {
    huly += `**${key}**\n`
    for (const value of values as string[]) {
      huly += `* [ ] ${value} \n` // todo: test and fix for checked items
    }
    huly += '\n'
  }
  return huly
}

function fixMultilineString (content: string) {
  return content.split('\\n').join('\n')
}

async function importPageDocument (
  client: TxOperations,
  uploadFile: FileUploader,
  name: string,
  data: Buffer,
  space: Ref<Teamspace>
): Promise<void> {
  const md = data.toString() ?? ''
  const json = parseMessageMarkdown(md ?? '', 'image://')

  const id = generateId<Document>()
  const collabId = makeCollaborativeDoc(id, 'description')
  const yDoc = jsonToYDocNoSchema(json, 'content')
  const { documentId } = collaborativeDocParse(collabId)
  const buffer = yDocToBuffer(yDoc)

  const form = new FormData()
  const file = new File([new Blob([buffer])], name)
  form.append('file', file, documentId)
  form.append('type', 'application/ydoc')
  form.append('size', buffer.length.toString())
  form.append('name', name)
  form.append('id', id)
  form.append('data', new Blob([buffer])) // ?

  await uploadFile(id, form)

  const parent = document.ids.NoParent
  const lastRank = await getFirstRank(client, space, parent)
  const rank = makeRank(lastRank, undefined)

  const attachedData: Data<Document> = {
    title: name,
    description: collabId,
    parent,
    attachments: 0,
    embeddings: 0,
    labels: 0,
    comments: 0,
    references: 0,
    rank
  }

  await client.createDoc(document.class.Document, space, attachedData, id)
}

export interface ClickupIssue extends Issue {
  clickupId: string
}

export async function createClickUpProjectType (client: TxOperations, statuses: string[]): Promise<Ref<ProjectType>> {
  return await createProjectType(
    client,
    {
      name: 'ClickUp project',
      descriptor: tracker.descriptors.ProjectType,
      shortDescription: 'For issues imported from ClickUp',
      description: '',
      tasks: [],
      roles: 0,
      classic: true
    },
    [
      {
        _id: CLICKUP_TASK_TYPE_ID,
        descriptor: tracker.descriptors.Issue,
        kind: 'both',
        name: 'ClickUp issue',
        ofClass: tracker.class.Issue,
        statusCategories: [task.statusCategory.UnStarted],
        statusClass: tracker.class.IssueStatus,
        icon: tracker.icon.Issue,
        color: 0,
        allowedAsChildOf: [CLICKUP_TASK_TYPE_ID],
        factory: statuses.map((status) => {
          return {
            name: status,
            ofAttribute: pluginState.attribute.IssueStatus,
            category: task.statusCategory.UnStarted
          }
        })
      }
    ],
    CLICKUP_PROJECT_TYPE_ID
  )
}

async function createProject (client: TxOperations, name: string, typeId: Ref<ProjectType>): Promise<Ref<Project>> {
  const projectId = generateId<Project>()
  const projectData = {
    name,
    description: '',
    private: false,
    members: [],
    owners: [],
    archived: false,
    autoJoin: false,
    identifier: 'AAA',
    sequence: 0,
    defaultAssignee: undefined,
    defaultIssueStatus: '' as Ref<IssueStatus>,
    defaultTimeReportDay: TimeReportDayType.PreviousWorkDay
  }
  await client.createDoc(tracker.class.Project, core.space.Space, { ...projectData, type: typeId }, projectId)
  // Add space type's mixin with roles assignments
  await client.createMixin(projectId, tracker.class.Project, core.space.Space, CLICKUP_MIXIN_ID, {})
  return projectId
}
