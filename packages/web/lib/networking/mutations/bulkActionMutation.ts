import { gql } from 'graphql-request'
import { gqlFetcher } from '../networkHelpers'

export enum BulkAction {
  ARCHIVE = 'ARCHIVE',
  DELETE = 'DELETE',
}

type BulkActionResponseData = {
  success: boolean
}

type BulkActionResponse = {
  errorCodes?: string[]
  bulkAction?: BulkActionResponseData
}

export async function bulkActionMutation(
  action: BulkAction,
  query: string
): Promise<boolean> {
  const mutation = gql`
    mutation {
      bulkAction(action: $action, query: $query) {
        ... on BulkActionSuccess {
          success
        }
        ... on BulkActionError {
          errorCodes
        }
      }
    }
  `

  console.log('bulkActionbulkActionMutation', mutation)

  try {
    const response = await gqlFetcher(mutation, { action, query })
    console.log('response', response)
    const data = response as BulkActionResponse | undefined
    return data?.bulkAction?.success ?? false
  } catch (error) {
    console.error(error)
    return false
  }
}
