import axios from 'axios'
import { parseHTML } from 'linkedom'
import { DateTime } from 'luxon'
import { Browser, BrowserContext } from 'puppeteer-core'
import { ContentHandler, PreHandleResult } from '../content-handler'

interface TweetIncludes {
  users: {
    id: string
    name: string
    profile_image_url: string
    username: string
  }[]
  media?: {
    preview_image_url: string
    type: string
    url: string
    media_key: string
  }[]
}

interface TweetMeta {
  result_count: number
}

interface TweetData {
  author_id: string
  text: string
  entities: {
    urls: {
      url: string
      expanded_url: string
      display_url: string
    }[]
  }
  created_at: string
  referenced_tweets: {
    type: string
    id: string
  }[]
  conversation_id: string
  attachments?: {
    media_keys: string[]
  }
}

interface Tweet {
  data: TweetData
  includes: TweetIncludes
}

interface Tweets {
  data: TweetData[]
  includes: TweetIncludes
  meta: TweetMeta
}

interface EmbedTweet {
  author_name: string
  author_url: string
  cache_age: string
  height: number
  html: string
  provider_name: string
  provider_url: string
  type: string
  url: string
  version: string
  width: number
}

const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN
const TWITTER_URL_MATCH =
  /(twitter|x)\.com\/(?:#!\/)?(\w+)\/status(?:es)?\/(\d+)(?:\/.*)?/
const MAX_THREAD_DEPTH = 100

const getTweetFields = () => {
  const TWEET_FIELDS =
    '&tweet.fields=attachments,author_id,conversation_id,created_at,' +
    'entities,geo,in_reply_to_user_id,lang,possibly_sensitive,public_metrics,referenced_tweets,' +
    'source,withheld'
  const EXPANSIONS = '&expansions=author_id,attachments.media_keys'
  const USER_FIELDS =
    '&user.fields=created_at,description,entities,location,pinned_tweet_id,profile_image_url,protected,public_metrics,url,verified,withheld'
  const MEDIA_FIELDS =
    '&media.fields=duration_ms,height,preview_image_url,url,media_key,public_metrics,width'

  return `${TWEET_FIELDS}${EXPANSIONS}${USER_FIELDS}${MEDIA_FIELDS}`
}

// unroll recent tweet thread
const getTweetThread = async (conversationId: string): Promise<Tweets> => {
  const BASE_ENDPOINT = 'https://api.twitter.com/2/tweets/search/recent'
  const apiUrl = new URL(
    BASE_ENDPOINT +
      '?query=' +
      encodeURIComponent(`conversation_id:${conversationId}`) +
      getTweetFields() +
      `&max_results=${MAX_THREAD_DEPTH}`
  )

  if (!TWITTER_BEARER_TOKEN) {
    throw new Error('No Twitter bearer token found')
  }

  const response = await axios.get<Tweets>(apiUrl.toString(), {
    headers: {
      Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
      redirect: 'follow',
    },
  })
  return response.data
}

const getEmbedTweet = async (url: string): Promise<EmbedTweet> => {
  const BASE_ENDPOINT = 'https://publish.twitter.com/oembed'
  const embedUrl = new URL(BASE_ENDPOINT + '?url=' + encodeURIComponent(url))

  const response = await axios.get<EmbedTweet>(embedUrl.toString())

  return response.data
}

const getTweetById = async (id: string): Promise<Tweet> => {
  const BASE_ENDPOINT = 'https://api.twitter.com/2/tweets/'
  const apiUrl = new URL(BASE_ENDPOINT + id + '?' + getTweetFields())

  if (!TWITTER_BEARER_TOKEN) {
    throw new Error('No Twitter bearer token found')
  }

  const response = await axios.get<Tweet>(apiUrl.toString(), {
    headers: {
      Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
      redirect: 'follow',
    },
  })

  return response.data
}

const getTweetsByIds = async (ids: string[]): Promise<Tweets> => {
  const BASE_ENDPOINT = 'https://api.twitter.com/2/tweets?ids='
  const apiUrl = new URL(BASE_ENDPOINT + ids.join() + getTweetFields())

  if (!TWITTER_BEARER_TOKEN) {
    throw new Error('No Twitter bearer token found')
  }

  const response = await axios.get<Tweets>(apiUrl.toString(), {
    headers: {
      Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
      redirect: 'follow',
    },
  })

  return response.data
}

const titleForTweet = (author: string, text: string) => {
  return `${author} on X: ${text.replace(/http\S+/, '')}`
}

const tweetIdFromStatusUrl = (url: string): string | undefined => {
  const match = url.toString().match(TWITTER_URL_MATCH)
  return match?.[2]
}

const formatTimestamp = (timestamp: string) => {
  return DateTime.fromJSDate(new Date(timestamp)).toLocaleString(
    DateTime.DATETIME_FULL
  )
}

const getTweetsFromResponse = (response: Tweets): Tweet[] => {
  const tweets = []
  for (const t of response.data) {
    const media = response.includes.media?.filter((m) =>
      t.attachments?.media_keys?.includes(m.media_key)
    )
    const tweet: Tweet = {
      data: t,
      includes: {
        users: response.includes.users,
        media,
      },
    }
    tweets.push(tweet)
  }
  return tweets
}

const getOldTweets = async (
  browser: Browser,
  conversationId: string,
  username: string
): Promise<Tweet[]> => {
  const tweetIds = await getTweetIds(browser, conversationId, username)
  if (tweetIds.length === 0) {
    return []
  }
  const response = await getTweetsByIds(tweetIds)
  return getTweetsFromResponse(response)
}

const getRecentTweets = async (conversationId: string): Promise<Tweet[]> => {
  const thread = await getTweetThread(conversationId)
  if (thread.meta.result_count === 0) {
    return []
  }
  // tweets are in reverse chronological order in the thread
  return getTweetsFromResponse(thread).reverse()
}

/**
 * Wait for `ms` amount of milliseconds
 * @param {number} ms
 */
const waitFor = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Get tweets(even older than 7 days) using puppeteer
 * @param browser
 * @param {string} tweetId
 * @param {string} author
 */
const getTweetIds = async (
  browser: Browser,
  tweetId: string,
  author: string
): Promise<string[]> => {
  const pageURL = `https://twitter.com/${author}/status/${tweetId}`

  let context: BrowserContext | undefined
  try {
    context = await browser.createIncognitoBrowserContext()
    const page = await context.newPage()

    // Modify this variable to control the size of viewport
    const deviceScaleFactor = 0.2
    const height = Math.floor(2000 / deviceScaleFactor)
    const width = Math.floor(1700 / deviceScaleFactor)
    await page.setViewport({ width, height, deviceScaleFactor })

    await page.goto(pageURL, {
      waitUntil: 'networkidle0',
      timeout: 60000, // 60 seconds
    })

    return await page.evaluate(async (author) => {
      /**
       * Wait for `ms` amount of milliseconds
       * @param {number} ms
       */
      const waitFor = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms))

      const ids = []

      // Find the first Show thread button and click it
      const showRepliesButton = Array.from(
        document.querySelectorAll('div[dir]')
      )
        .filter(
          (node) => node.children[0] && node.children[0].tagName === 'SPAN'
        )
        .find((node) => node.children[0].innerHTML === 'Show replies')

      if (showRepliesButton) {
        ;(showRepliesButton as HTMLElement).click()

        await waitFor(2000)
      }

      const timeNodes = Array.from(document.querySelectorAll('time'))

      for (const timeNode of timeNodes) {
        /** @type {HTMLAnchorElement | HTMLSpanElement} */
        const timeContainerAnchor: HTMLAnchorElement | HTMLSpanElement | null =
          timeNode.parentElement
        if (!timeContainerAnchor) continue

        if (timeContainerAnchor.tagName === 'SPAN') continue

        const href = timeContainerAnchor.getAttribute('href')
        if (!href) continue

        // Get the tweet id and username from the href: https://twitter.com/username/status/1234567890
        const match = href.match(/\/([^/]+)\/status\/(\d+)/)
        if (!match) continue

        const id = match[2]
        const username = match[1]

        // skip non-author replies
        username === author && ids.push(id)
      }

      return ids
    }, author)
  } catch (error) {
    console.error('Error getting tweets', error)

    return []
  } finally {
    if (context) {
      await context.close()
    }
  }
}

export class TwitterHandler extends ContentHandler {
  constructor() {
    super()
    this.name = 'Twitter'
  }

  shouldPreHandle(url: string): boolean {
    return TWITTER_URL_MATCH.test(url.toString())
  }

  async preHandle(url: string): Promise<PreHandleResult> {
    const embedTweet = await getEmbedTweet(url)
    console.log('embedTweet', embedTweet)
    const html = embedTweet.html

    const dom = parseHTML(html).document

    const tweetText = dom.querySelector('p')?.textContent ?? ''
    const title = titleForTweet(embedTweet.author_name, tweetText)
    const publisedDate =
      dom.querySelector('a[href*="/status/"]')?.textContent ?? ''

    const content = `
      <html>
          <head>
            <meta property="og:site_name" content="X (formerly Twitter)" />
            <meta property="og:type" content="tweet" />
            <meta property="dc:creator" content="${embedTweet.author_name}" />
            <meta property="twitter:description" content="${tweetText}" />
            <meta property="article:published_time" content="${publisedDate}" />
          </head>
          <body>
            <div>
              ${embedTweet.html}
            </div>
          </body>
      </html>`

    return {
      content,
      url,
      title,
    }
  }
}
