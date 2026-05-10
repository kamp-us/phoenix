import * as React from 'react';
import { PanoPost, PanoCommentTree, type PanoPostData, type CommentData } from '../components/pano/index';
import { Subnav } from '../components/layout/Subnav';
import { Form, Field, Label, Textarea } from '../components/ui/Form';
import { Button } from '../components/ui/Button';
import { Tabs } from '../components/ui/Tabs';
export function PanoPostDetail({
  post,
  comments,
}: {
  post: PanoPostData;
  comments: CommentData[];
}) {
  return (
    <>
      <Subnav title="pano" count="başlık" />
      <PanoPost post={post} />
      <div style={{ marginTop: 'var(--s-3)' }}>
        <Tabs.Root variant="pill" defaultValue="yaz">
          <Tabs.List>
            <Tabs.Tab value="yaz">yaz</Tabs.Tab>
            <Tabs.Tab value="onizle">önizle</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="yaz" style={{ paddingTop: 'var(--s-2)' }}>
            <Form>
              <Field name="comment">
                <Label>yorumun</Label>
                <Textarea name="comment" rows={4} placeholder="bir şeyler yaz..." />
              </Field>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="primary">yorum yap</Button>
              </div>
            </Form>
          </Tabs.Panel>
          <Tabs.Panel value="onizle" style={{ paddingTop: 'var(--s-2)' }}>
            <em>(önizleme alanı)</em>
          </Tabs.Panel>
        </Tabs.Root>
      </div>
      <h2 style={{ font: 'var(--t-h-page)', marginTop: 'var(--s-4)' }}>
        {comments.length} yorum
      </h2>
      <PanoCommentTree comments={comments} />
    </>
  );
}
